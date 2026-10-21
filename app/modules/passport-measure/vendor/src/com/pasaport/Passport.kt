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
    val deviceId: String = "", // 0.2: made once per install (Together.kt)
    val kind: String = "phone", // 0.2: phone · tablet · computer
    val os: String = "", // 0.2: "android 15"
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
    }.let { if (compact) it.toString() else it.toString(2) }
}
