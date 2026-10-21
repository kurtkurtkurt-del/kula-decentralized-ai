package expo.modules.passportmeasure

import com.pasaport.measureAll
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The device passport, measured natively (com.pasaport.Measure.kt, written in the sibling
// session and taken as is): RAM, SoC, cpufreq, a 256 MB arraycopy bandwidth test, a
// 512×512 matrix multiply on every core, StatFs, BatteryManager. measureAsync() answers
// the passport/0.1 JSON as a string; data/passport.ts parses it.
class PassportMeasureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PassportMeasure")

    AsyncFunction("measureAsync") Coroutine { ->
      val context = appContext.reactContext ?: throw IllegalStateException("no react context")
      measureAll(context).toJson()
    }
  }
}
