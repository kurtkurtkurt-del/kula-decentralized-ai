package com.pasaport

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.io.File
import kotlin.math.max
import kotlin.math.min

// Phase 1 of the better passport (passport/0.3, 21.10.2026). What the tests taught, and
// what this file measures because of it:
//  - one core copying memory is not what a model runner does (it reads with several
//    threads): bandwidth is read with 1, 2, 4, 6, 8 threads, the best count is kept;
//  - the thread count alone moved generation speed by up to 55% on a Snapdragon 8 Elite
//    (llama.cpp discussion #23736): the core clusters are kept, so a runner can pick;
//  - llama.cpp's fast kernels need dotprod / i8mm / sve: the cpu features are kept;
//  - heat halved the speed in one session (4.0 → 1.94 tok/s, wifi split test 11.10.2026):
//    the thermal state is kept, and the estimate is a range with a hot end;
//  - the phone's GPU read prompts 24x faster (OpenCL on Adreno): which backends exist;
//  - 2.4 GHz moved the model at 1.7 MB/s, 5 GHz at 23 MB/s: the wifi band;
//  - what Android lets a process hold is "available" x 0.8, minus the context's KV cache
//    and buffers (the split test: ~0.6 GB for 2048 tokens of a 14B model).
// None of the factors below is calibrated against a model run on the phone alone yet:
// the estimate says so (source "estimate"). contract/budget-cases.json pins the rule.

@Volatile private var blackhole = 0L

data class Cluster(val count: Int, val maxGhz: Double)
data class Thermal(val status: Int, val headroom: Double, val batteryC: Double)
data class Gpu(val opencl: Boolean, val vulkan: String, val model: String)
data class Wifi(val band: String, val linkMbps: Int)
data class Budget(val ctx: Int, val reserveGb: Double, val ramGb: Double, val q4kmB: Double, val q3ksB: Double, val q80B: Double)
data class Estimate(val fitB: Int, val tpsLow: Double, val tpsHigh: Double, val source: String)

/** GB per billion parameters, from real files (Qwen 14B: Q4_K_M 9.0 GB, Q3_K_S 6.66 GB). */
object Quant {
    const val Q4_K_M = 0.61
    const val Q3_K_S = 0.45
    const val Q8_0 = 1.06
}

/** The rule behind budget and estimate; contract/budget-cases.json is its judge. */
object Rule {
    const val USABLE = 0.8 // of "available": what Android let Termux keep (split test)
    const val CTX = 2048
    const val RESERVE_GB = 0.5 // KV cache for CTX tokens + compute buffers (split test: ~0.3-0.6 GB)
    const val EFFICIENCY = 0.6 // share of the best read bandwidth a runner turns into weights read: a guess
    const val HOT = 0.5 // the hot end of the range: 4.0 → 1.94 tok/s in the split test
    val STEPS = intArrayOf(1, 3, 4, 7, 8, 12, 14)
}

fun budget(ramFreeGb: Double): Budget {
    val ram = max(0.0, ramFreeGb * Rule.USABLE - Rule.RESERVE_GB).r2()
    return Budget(
        ctx = Rule.CTX, reserveGb = Rule.RESERVE_GB, ramGb = ram,
        q4kmB = (ram / Quant.Q4_K_M).r1(), q3ksB = (ram / Quant.Q3_K_S).r1(), q80B = (ram / Quant.Q8_0).r1(),
    )
}

/** Tokens/s for the largest Q4_K_M step the budget holds, cool (high) and hot (low). */
fun estimate(b: Budget, readBwGbs: Double): Estimate {
    val fit = Rule.STEPS.lastOrNull { it * Quant.Q4_K_M <= b.ramGb } ?: 0
    val sizeGb = max(fit, 1) * Quant.Q4_K_M
    val high = if (readBwGbs > 0) readBwGbs * Rule.EFFICIENCY / sizeGb else 0.0
    return Estimate(fitB = fit, tpsLow = (high * Rule.HOT).r1(), tpsHigh = high.r1(), source = "estimate")
}

/**
 * Read bandwidth in GB/s for each thread count: every thread sums its slice of one
 * LongArray (128 MB, smaller if the heap refuses), again and again for at least 150 ms
 * after a warm-up. Reading is what a model runner does with the weights.
 */
suspend fun readBandwidthByThreads(cores: Int): Map<Int, Double> = coroutineScope {
    var arr: LongArray? = null
    for (mb in intArrayOf(128, 64, 32)) {
        arr = try { LongArray(mb * 1024 * 1024 / 8) } catch (e: OutOfMemoryError) { null }
        if (arr != null) break
    }
    val a = arr ?: return@coroutineScope emptyMap()
    for (i in a.indices step 512) a[i] = i.toLong() // touch the pages
    val counts = intArrayOf(1, 2, 4, 6, 8).filter { it <= max(1, cores) }
    val out = linkedMapOf<Int, Double>()
    var sink = 0L
    for (t in counts) {
        val slice = (a.size + t - 1) / t
        suspend fun pass(): Long = coroutineScope {
            (0 until t).map { w ->
                async(Dispatchers.Default) {
                    var s = 0L
                    val from = w * slice
                    val to = min(a.size, from + slice)
                    for (i in from until to) s += a[i]
                    s
                }
            }.awaitAll().sum()
        }
        sink += pass() // warm-up
        var passes = 0
        val t0 = System.nanoTime()
        while (System.nanoTime() - t0 < 150_000_000L || passes < 3) { sink += pass(); passes++ }
        val sec = (System.nanoTime() - t0) / 1e9
        out[t] = (a.size * 8.0 * passes / sec / 1e9).r2()
    }
    blackhole = sink // keeps the sums alive, so the JIT cannot skip the reads
    out
}

/** The CPU's clusters: cores grouped by their top frequency, fastest first. */
fun clusters(): List<Cluster> {
    val dirs = File("/sys/devices/system/cpu").listFiles { f -> f.isDirectory && f.name.matches(Regex("cpu\\d+")) } ?: return emptyList()
    val khz = dirs.mapNotNull { d -> runCatching { File(d, "cpufreq/cpuinfo_max_freq").readText().trim().toLong() }.getOrNull() }
    return khz.groupingBy { it }.eachCount().entries.sortedByDescending { it.key }
        .map { (k, n) -> Cluster(count = n, maxGhz = (k / 1_000_000.0).r2()) }
}

/** The CPU features llama.cpp's fast kernels look for, as /proc/cpuinfo names them. */
fun cpuFeatures(): List<String> {
    val wanted = listOf("asimddp", "i8mm", "sve", "sve2", "bf16", "asimdhp", "fphp")
    val line = runCatching { File("/proc/cpuinfo").readLines().firstOrNull { it.startsWith("Features") } }.getOrNull() ?: return emptyList()
    val have = line.substringAfter(":").trim().split(Regex("\\s+")).toSet()
    return wanted.filter { it in have }
}

/** Android's thermal status (0 none … 6 shutdown, -1 unknown), headroom (1.0 = throttling), battery °C. */
fun thermal(context: Context): Thermal {
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val status = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) pm.currentThermalStatus else -1
    val headroom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) pm.getThermalHeadroom(0).toDouble().takeIf { !it.isNaN() }?.r2() ?: -1.0 else -1.0
    val battery: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val tenths = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE
    return Thermal(status = status, headroom = headroom, batteryC = if (tenths == Int.MIN_VALUE) -1.0 else (tenths / 10.0).r1())
}

/** The GPU paths a runner could use: an OpenCL driver, the Vulkan version, the GPU's name. */
fun gpu(context: Context): Gpu {
    val opencl = listOf("/vendor/lib64/libOpenCL_adreno.so", "/vendor/lib64/libOpenCL.so", "/system/vendor/lib64/libOpenCL.so").any { File(it).exists() }
    val vk = context.packageManager.systemAvailableFeatures.firstOrNull { it.name == PackageManager.FEATURE_VULKAN_HARDWARE_VERSION }?.version
    val vulkan = if (vk == null || vk == 0) "" else "${vk ushr 22}.${(vk ushr 12) and 0x3ff}"
    val model = runCatching { File("/sys/class/kgsl/kgsl-3d0/gpu_model").readText().trim() }.getOrDefault("")
    return Gpu(opencl = opencl, vulkan = vulkan, model = model)
}

/** The Wi-Fi band ("2.4", "5", "6", "" when not on Wi-Fi) and link speed in Mbps. */
@SuppressLint("MissingPermission")
@Suppress("DEPRECATION")
fun wifi(context: Context): Wifi = runCatching {
    val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    val info = wm.connectionInfo ?: return Wifi("", 0)
    val f = info.frequency
    val band = when {
        info.networkId == -1 && f <= 0 -> ""
        f in 1..2999 -> "2.4"
        f in 3000..5924 -> "5"
        f >= 5925 -> "6"
        else -> ""
    }
    Wifi(band = band, linkMbps = max(0, info.linkSpeed))
}.getOrDefault(Wifi("", 0))
