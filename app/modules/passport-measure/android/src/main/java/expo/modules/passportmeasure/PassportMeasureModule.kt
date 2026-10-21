package expo.modules.passportmeasure

import com.pasaport.PassportCore
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The device passport, measured by device-passport's own code: PassportCore and the files
// beside it come from ../device-passport/passport-core (see ../build.gradle), not from a copy
// here. This bridge only hands JS the json and says which API it speaks; src/passport/
// contract.ts decides whether kula reads it.
class PassportMeasureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PassportMeasure")

    Constants("api" to PassportCore.API, "schema" to PassportCore.SCHEMA)

    // kula sets the device id itself (data/passport.ts), the one its qr codes carry.
    AsyncFunction("measureAsync") Coroutine { ->
      val context = appContext.reactContext ?: throw IllegalStateException("no react context")
      PassportCore.measureJson(context)
    }
  }
}
