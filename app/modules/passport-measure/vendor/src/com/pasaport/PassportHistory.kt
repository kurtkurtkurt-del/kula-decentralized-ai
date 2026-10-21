package com.pasaport

import android.content.Context
import org.json.JSONArray

/**
 * Every passport this device measured, kept on the device (21.10.2026: "record every
 * test"). Compact json, newest last, at most MAX; nothing is sent from here. The apps add
 * to it after a measurement (device-passport: MainActivity; kula keeps its own list in JS
 * and on its server).
 */
object PassportHistory {
    private const val PREFS = "passport_history"
    private const val KEY = "items"
    const val MAX = 500

    fun append(context: Context, p: Passport) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val items = runCatching { JSONArray(prefs.getString(KEY, "[]")) }.getOrDefault(JSONArray())
        items.put(p.toJson(compact = true))
        val kept = JSONArray()
        for (i in maxOf(0, items.length() - MAX) until items.length()) kept.put(items.getString(i))
        prefs.edit().putString(KEY, kept.toString()).apply()
    }

    /** The passports as json strings, oldest first. */
    fun all(context: Context): List<String> {
        val raw = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]")
        val items = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        return (0 until items.length()).map { items.getString(it) }
    }

    fun count(context: Context): Int = all(context).size
}
