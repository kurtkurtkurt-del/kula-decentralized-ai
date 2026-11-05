// A stand-in for android.util.Log so Gate.kt compiles on a plain JVM. Under the Android
// unit test runner the real class returns defaults (testOptions.unitTests.returnDefaultValues).
package android.util

object Log {
  @JvmStatic fun i(tag: String, msg: String): Int = 0
  @JvmStatic fun w(tag: String, msg: String): Int = 0
  @JvmStatic fun e(tag: String, msg: String): Int = 0
  @JvmStatic fun d(tag: String, msg: String): Int = 0
}
