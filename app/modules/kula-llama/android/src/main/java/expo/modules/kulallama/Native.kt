package expo.modules.kulallama

import java.io.File

// The JNI surface of libkula_llama.so (kula_llama.cpp binds these in JNI_OnLoad). One model
// per process: the app process runs the master/local model, the :worker process serves.
object Native {
  init {
    System.loadLibrary("kula_llama")
  }

  @JvmStatic external fun initBackends(libDir: String): Boolean
  /** "key\tvalue\n" lines of the GGUF header, or null when the file is not a GGUF. */
  @JvmStatic external fun ggufMeta(path: String): String?
  /** "<local layers>\t<layers>\t<n_ctx>"; throws RuntimeException with the reason. */
  @JvmStatic external fun loadModel(
    path: String, threads: Int, ctx: Int, endpoints: Array<String>, weights: FloatArray, localWeight: Float,
  ): String
  @JvmStatic external fun freeModel()
  @JvmStatic external fun isLoaded(): Boolean
  @JvmStatic external fun applyTemplate(roles: Array<String>, contents: Array<String>): String
  /** Blocks; streams pieces to [cb]; returns generated tokens, -1 when stopped before the first. */
  @JvmStatic external fun generate(
    prompt: String, maxTokens: Int, temperature: Float, topP: Float, topK: Int, minP: Float,
    repeatPenalty: Float, seed: Int, cb: (String) -> Unit,
  ): Int
  @JvmStatic external fun stop()
  @JvmStatic external fun tokensUsed(): Int
  @JvmStatic external fun contextSize(): Int
  @JvmStatic external fun clearContext()
  @JvmStatic external fun lastLoadBuffers(): String
  @JvmStatic external fun workerPeer(): String?
  @JvmStatic external fun memBandwidth(threads: Int): Double
  @JvmStatic external fun serve(libDir: String, endpoint: String, cacheDir: String, threads: Int): String

  /**
   * Fast cores this process may run on (PrivateLM's finding: ggml threads wait for each
   * other every step, so one thread per *available* fast core, never more; 8 threads on a
   * Poco F1 worker ran at 0.1 tok/s, 2 ran at 3 tok/s).
   */
  fun fastCoreCount(): Int {
    val allowed = runCatching {
      File("/proc/self/status").readLines()
        .firstOrNull { it.startsWith("Cpus_allowed_list:") }
        ?.substringAfter(':')?.trim()?.split(',')
        ?.flatMap { range ->
          val parts = range.split('-')
          val a = parts[0].trim().toInt()
          val b = (parts.getOrNull(1) ?: parts[0]).trim().toInt()
          (a..b).toList()
        }
    }.getOrNull() ?: (0 until Runtime.getRuntime().availableProcessors()).toList()
    val maxFreq = allowed.associateWith { cpu ->
      File("/sys/devices/system/cpu/cpu$cpu/cpufreq/cpuinfo_max_freq")
        .takeIf { it.canRead() }?.readText()?.trim()?.toLongOrNull() ?: 0L
    }
    val top = maxFreq.values.maxOrNull() ?: 0L
    val fast = if (top > 0) maxFreq.count { it.value >= top * 0.8 } else allowed.size / 2
    return fast.coerceIn(2, 6)
  }

  /** Parses ggufMeta's lines. */
  fun meta(path: String): Map<String, String> =
    ggufMeta(path)?.lines()?.filter { it.contains('\t') }?.associate { it.substringBefore('\t') to it.substringAfter('\t') }
      ?: emptyMap()
}
