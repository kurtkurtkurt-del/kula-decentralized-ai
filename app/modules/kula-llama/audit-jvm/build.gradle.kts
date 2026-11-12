// Compiles expo.modules.kulallama.audit (plus the plain Kotlin beside it: Gate.kt, Guard.kt, Keys.kt,
// Trust.kt, Auto.kt...; Gate.kt's only Android import is Log, stubbed in stub/) straight from the
// module's source tree and runs the junit4 tests.
//   cd app/modules/kula-llama/audit-jvm && gradle test
plugins { kotlin("jvm") version "2.0.21" }

repositories { mavenCentral() }

// no toolchain pin: whatever JDK runs gradle (17 or newer) compiles and runs the tests
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

sourceSets {
  main {
    kotlin.setSrcDirs(listOf("../android/src/main/java/expo/modules/kulallama", "stub"))
    // these need the Android SDK
    kotlin.exclude("ApiServer.kt", "Discovery.kt", "Keeper.kt", "KeyStoreVault.kt", "KulaLlamaModule.kt", "ModelDownloader.kt", "Native.kt", "WorkerService.kt", "Vision.kt", "KeyStoreAttester.kt")
  }
  test {
    kotlin.setSrcDirs(listOf("../android/src/test/java/expo/modules/kulallama"))
    kotlin.exclude("VisionTest.kt") // Vision.kt needs android.graphics
  }
}

dependencies {
  implementation("org.json:json:20240303")
  implementation("com.squareup.okhttp3:okhttp:4.12.0") // Relay.kt, which Gate.kt reaches since the relay
  testImplementation("junit:junit:4.13.2")
}

tasks.test {
  useJUnit()
  // the tests read ../tools/*.json the way they do under the Android unit test runner
  workingDir = file("../android")
  testLogging { events("passed", "failed", "skipped"); showStandardStreams = false }
}
