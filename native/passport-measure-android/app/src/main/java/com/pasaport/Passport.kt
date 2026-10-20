package com.pasaport

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
) {
    fun toJson(): String = JSONObject().apply {
        put("schema", "passport/0.1")
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
    }.toString(2)
}
