package com.pasaport

import org.json.JSONArray
import org.json.JSONObject

data class Passport(
    val device: String,
    val soc: String,
    val android: String,
    val ramTotalGb: Double,
    val ramFreeGb: Double,
    val appMemCapMb: Int,
    val cpuCores: Int,
    val cpuMaxGhz: Double,
    val memBwGbs: Double,
    val gflops: Double,
    val storageFreeGb: Double,
    val batteryPct: Int,
    val charging: Boolean,
    val largestModelQ4: String,
    val estTps: Double,
    val measuredAt: String,
    val deviceId: String = "", // 0.2: made once per install (Together.kt)
    val kind: String = "phone", // 0.2: phone · tablet · computer
    val os: String = "", // 0.2: "android 15"
    // 0.3 (21.10.2026): phase 1 of the better passport (Probe.kt)
    val memBwReadGbs: Double = 0.0, // the best of bwThreads
    val bwThreads: Map<Int, Double> = emptyMap(), // read bandwidth per thread count
    val bestThreads: Int = 0,
    val clusters: List<Cluster> = emptyList(),
    val cpuFeatures: List<String> = emptyList(),
    val thermal: Thermal = Thermal(-1, -1.0, -1.0),
    val gpu: Gpu = Gpu(false, "", ""),
    val wifi: Wifi = Wifi("", 0),
    val budget: Budget = budget(0.0),
    val estimate: Estimate = Estimate(0, 0.0, 0.0, "estimate"),
    val measureMs: Long = 0,
) {
    /** The passport as json; compact is what the qr code carries. */
    fun toJson(compact: Boolean = false): String = JSONObject().apply {
        put("schema", PassportCore.SCHEMA)
        put("device", device)
        put("soc", soc)
        put("android", android)
        put("ram_total_gb", ramTotalGb)
        put("ram_free_gb", ramFreeGb)
        put("app_mem_cap_mb", appMemCapMb)
        put("cpu_cores", cpuCores)
        put("cpu_max_ghz", cpuMaxGhz)
        put("mem_bw_gbs", memBwGbs)
        put("gflops", gflops)
        put("storage_free_gb", storageFreeGb)
        put("battery_pct", batteryPct)
        put("charging", charging)
        put("largest_model_q4", largestModelQ4)
        put("est_tps", estTps)
        put("measured_at", measuredAt)
        put("device_id", deviceId)
        put("kind", kind)
        put("os", os.ifBlank { "android $android" })
        put("mem_bw_read_gbs", memBwReadGbs)
        put("bw_threads", JSONObject().apply { bwThreads.forEach { (t, v) -> put(t.toString(), v) } })
        put("best_threads", bestThreads)
        put("clusters", JSONArray().apply { clusters.forEach { put(JSONObject().put("count", it.count).put("max_ghz", it.maxGhz)) } })
        put("cpu_features", JSONArray(cpuFeatures))
        put("thermal", JSONObject().put("status", thermal.status).put("headroom", thermal.headroom).put("battery_c", thermal.batteryC))
        put("gpu", JSONObject().put("opencl", gpu.opencl).put("vulkan", gpu.vulkan).put("model", gpu.model))
        put("wifi", JSONObject().put("band", wifi.band).put("link_mbps", wifi.linkMbps))
        put("budget", JSONObject().put("ctx", budget.ctx).put("reserve_gb", budget.reserveGb).put("ram_gb", budget.ramGb)
            .put("q4_k_m_b", budget.q4kmB).put("q3_k_s_b", budget.q3ksB).put("q8_0_b", budget.q80B))
        put("estimate", JSONObject().put("fit_b", estimate.fitB).put("tps_low", estimate.tpsLow).put("tps_high", estimate.tpsHigh).put("source", estimate.source))
        put("measure_ms", measureMs)
    }.let { if (compact) it.toString() else it.toString(2) }
}
