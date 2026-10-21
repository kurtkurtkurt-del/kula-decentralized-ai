package com.pasaport

import android.app.ActivityManager
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.min
import kotlin.math.floor

private const val GB = 1024.0 * 1024.0 * 1024.0

// Half up, one or two decimals: the same as Math.round in kula's JS (contract/CONTRACT.md).
// kotlin.math.round is half-even and gave 0.2 where JS gave 0.3 for 0.25.
internal fun Double.r1() = floor(this * 10 + 0.5) / 10
internal fun Double.r2() = floor(this * 100 + 0.5) / 100

/** Runs every measurement on Dispatchers.Default and returns the finished passport. */
suspend fun measureAll(context: Context): Passport = withContext(Dispatchers.Default) {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    val ramTotalGb = (mi.totalMem / GB).r1()
    val ramFreeGb = (mi.availMem / GB).r1()
    val appMemCapMb = am.largeMemoryClass
    val cores = Runtime.getRuntime().availableProcessors()
    val cpuMaxGhz = cpuMaxGhz()

    val memBw = memBandwidthGbs().r2()
    val gflops = gflops(cores).r2()

    val stat = StatFs(Environment.getDataDirectory().path)
    val storageFreeGb = (stat.availableBytes / GB).r1()

    val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    val batteryPct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    val charging = bm.isCharging

    val (model, tps) = estimateModel(ramFreeGb, memBw)

    Passport(
        device = "${Build.MANUFACTURER} ${Build.MODEL}",
        soc = socName(),
        android = Build.VERSION.RELEASE,
        ramTotalGb = ramTotalGb,
        ramFreeGb = ramFreeGb,
        appMemCapMb = appMemCapMb,
        cpuCores = cores,
        cpuMaxGhz = cpuMaxGhz,
        memBwGbs = memBw,
        gflops = gflops,
        storageFreeGb = storageFreeGb,
        batteryPct = batteryPct,
        charging = charging,
        largestModelQ4 = model,
        estTps = tps,
        measuredAt = isoNow(),
    )
}

fun socName(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val s = Build.SOC_MODEL
        if (!s.isNullOrBlank() && s != Build.UNKNOWN) return s
    }
    return Build.HARDWARE
}

/** Highest cpuinfo_max_freq across all cores, in GHz; 0.0 if unreadable. */
fun cpuMaxGhz(): Double {
    val dirs = File("/sys/devices/system/cpu").listFiles { f ->
        f.isDirectory && f.name.matches(Regex("cpu\\d+"))
    } ?: return 0.0
    var maxKhz = 0L
    for (d in dirs) {
        val khz = runCatching {
            File(d, "cpufreq/cpuinfo_max_freq").readText().trim().toLong()
        }.getOrNull() ?: continue
        maxKhz = max(maxKhz, khz)
    }
    return (maxKhz / 1_000_000.0).r2()
}

/**
 * Memory bandwidth in GB/s. Allocates one FloatArray (256 MB, falling back to
 * smaller sizes if the heap refuses) and copies it end to end with
 * System.arraycopy: first half -> second half, then back. One warm-up pass is
 * not counted; 3 passes are timed. Traffic per pass = read + write = 2 x size.
 */
fun memBandwidthGbs(): Double {
    val sizes = intArrayOf(256, 128, 64, 32)
    var arr: FloatArray? = null
    var bytes = 0L
    for (mb in sizes) {
        arr = try {
            FloatArray(mb * 1024 * 1024 / 4)
        } catch (e: OutOfMemoryError) {
            null
        }
        if (arr != null) { bytes = mb.toLong() * 1024 * 1024; break }
    }
    val a = arr ?: return 0.0
    val half = a.size / 2
    for (i in a.indices step 4096) a[i] = i.toFloat() // touch pages so they are mapped

    fun pass() {
        System.arraycopy(a, 0, a, half, half)
        System.arraycopy(a, half, a, 0, half)
    }

    pass() // warm-up, not counted
    val passes = 3
    val t0 = System.nanoTime()
    repeat(passes) { pass() }
    val sec = (System.nanoTime() - t0) / 1e9
    val traffic = 2.0 * bytes * passes
    return traffic / sec / 1e9
}

/**
 * Multi-core 512x512 float matrix multiply, rows split across [cores]
 * coroutines on Dispatchers.Default. One warm-up run, then 3 timed repeats.
 * GFLOPS = 3 x 2n^3 / total time.
 */
suspend fun gflops(cores: Int): Double {
    val n = 512
    val a = FloatArray(n * n) { (it % 7) * 0.5f }
    val b = FloatArray(n * n) { (it % 5) * 0.25f }
    val c = FloatArray(n * n)

    suspend fun multiply() = coroutineScope {
        val workers = max(1, cores)
        val rowsPer = (n + workers - 1) / workers
        for (w in 0 until workers) {
            val r0 = w * rowsPer
            val r1 = min(n, r0 + rowsPer)
            if (r0 >= r1) continue
            launch(Dispatchers.Default) {
                for (i in r0 until r1) {
                    val ci = i * n
                    java.util.Arrays.fill(c, ci, ci + n, 0f)
                    for (k in 0 until n) {
                        val aik = a[i * n + k]
                        val bk = k * n
                        for (j in 0 until n) c[ci + j] += aik * b[bk + j]
                    }
                }
            }
        }
    }

    multiply() // warm-up, not counted
    val repeats = 3
    val t0 = System.nanoTime()
    repeat(repeats) { multiply() }
    val sec = (System.nanoTime() - t0) / 1e9
    val flops = repeats * 2.0 * n.toDouble() * n * n
    return flops / sec / 1e9
}

/**
 * Largest Q4 model that fits: usable = free RAM x 0.8, ~0.6 GB per 1B parameters.
 * Returns the label and a rough tokens/s estimate (bandwidth / model size x 0.5).
 * Not the app memory cap (largeMemoryClass): that limits the Java heap only, and a
 * model runner such as llama.cpp allocates native memory (21.10.2026).
 */
fun estimateModel(ramFreeGb: Double, memBwGbs: Double): Pair<String, Double> {
    val usable = ramFreeGb * 0.8
    val steps = intArrayOf(1, 3, 4, 7, 8, 12, 14)
    val fit = steps.lastOrNull { it * 0.6 <= usable }
    val label = if (fit == null) "<1B" else "~${fit}B"
    val sizeGb = (fit ?: 1) * 0.6
    val tps = if (sizeGb > 0 && memBwGbs > 0) memBwGbs / sizeGb * 0.5 else 0.0
    return label to tps.r1()
}

/** ISO 8601 in UTC. Not java.time.Instant: that needs API 26 and kula runs from API 24. */
internal fun isoNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
    .apply { timeZone = TimeZone.getTimeZone("UTC") }
    .format(Date())
