package com.pasaport

import android.content.Context
import android.os.Build

/**
 * The one door into the measurement. Both apps call it: device-passport (MainActivity) and
 * kula decentralized ai (its Expo module, app/modules/passport-measure, compiles this very
 * file from ../device-passport/passport-core). Improve the measurement here and kula gets it
 * on its next build. What may change without telling kula, and what may not, is written in
 * contract/CONTRACT.md; contract/ holds the numbers both sides test against.
 */
object PassportCore {
    /**
     * Bump when a caller has to change: a signature in this object, or a field's meaning or
     * unit. kula lists the API versions it understands and falls back to its JS measurement
     * on any other (src/passport/contract.ts).
     */
    const val API = 1

    /** The json toJson() writes. Minor: fields added. Major: a field renamed or removed. */
    const val SCHEMA = "passport/0.2"

    /** Measures this device: who it is (id, kind, os) is filled in here for every caller. */
    suspend fun measure(context: Context, deviceId: String = ""): Passport {
        val app = context.applicationContext
        val tablet = app.resources.configuration.smallestScreenWidthDp >= 600
        return measureAll(app).copy(
            deviceId = deviceId,
            kind = if (tablet) "tablet" else "phone",
            os = "android ${Build.VERSION.RELEASE}",
        )
    }

    /** The same, as the passport json (pretty; compact is what a qr code carries). */
    suspend fun measureJson(context: Context, deviceId: String = "", compact: Boolean = false): String =
        measure(context, deviceId).toJson(compact)
}
