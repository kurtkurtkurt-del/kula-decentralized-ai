// kula-llama JNI: the Android face of cpp/core (kula_core.h). Bound to
// expo.modules.kulallama.Native with RegisterNatives, so the package name lives in one
// place (kNatives, bottom of this file). No logic here: strings and arrays cross, errors
// become RuntimeException with the core's reason.
#include <jni.h>
#include <string>
#include <vector>
#include <android/log.h>
#include "kula_core.h"

#define LOG_TAG "kula-llama"

static void androidSink(kula::LogLevel level, const char* text) {
    __android_log_write(level == kula::LogLevel::Error ? ANDROID_LOG_ERROR
                        : level == kula::LogLevel::Warn ? ANDROID_LOG_WARN : ANDROID_LOG_INFO, LOG_TAG, text);
}

static std::string jstr(JNIEnv* env, jstring value) {
    if (!value) return {};
    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (!chars) return {};
    std::string out(chars);
    env->ReleaseStringUTFChars(value, chars);
    return out;
}

static std::vector<std::string> jstrs(JNIEnv* env, jobjectArray arr) {
    std::vector<std::string> out;
    const jsize n = arr ? env->GetArrayLength(arr) : 0;
    for (jsize i = 0; i < n; i++) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(arr, i));
        out.push_back(jstr(env, item));
        env->DeleteLocalRef(item);
    }
    return out;
}

static void throwRuntime(JNIEnv* env, const std::string& message) {
    __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, message.c_str());
    env->ThrowNew(env->FindClass("java/lang/RuntimeException"), message.c_str());
}

static jboolean nInitBackends(JNIEnv* env, jclass, jstring lib_dir) {
    kula::setLogSink(androidSink);
    return kula::initBackends(jstr(env, lib_dir)) ? JNI_TRUE : JNI_FALSE;
}

static jstring nGgufMeta(JNIEnv* env, jclass, jstring jpath) {
    std::string out;
    if (!kula::ggufMeta(jstr(env, jpath), out)) return nullptr;
    return env->NewStringUTF(out.c_str());
}

// Returns "<local layers>\t<total layers>\t<n_ctx>" or throws.
static jstring nLoadModel(JNIEnv* env, jclass, jstring jpath, jint n_threads, jint ctx_size,
                          jobjectArray endpoints, jfloatArray weights, jfloat local_weight) {
    std::vector<float> ws;
    if (weights) {
        const jsize n = env->GetArrayLength(weights);
        ws.resize(n);
        env->GetFloatArrayRegion(weights, 0, n, ws.data());
    }
    kula::LoadResult r;
    std::string err;
    if (!kula::loadModel(jstr(env, jpath), n_threads, ctx_size, jstrs(env, endpoints), ws, local_weight, r, err)) {
        throwRuntime(env, err);
        return nullptr;
    }
    const std::string out = std::to_string(r.local_layers) + "\t" + std::to_string(r.layers) + "\t" + std::to_string(r.n_ctx);
    return env->NewStringUTF(out.c_str());
}

static void nFreeModel(JNIEnv*, jclass) { kula::freeModel(); }
static jboolean nIsLoaded(JNIEnv*, jclass) { return kula::isLoaded() ? JNI_TRUE : JNI_FALSE; }

static jstring nApplyTemplate(JNIEnv* env, jclass, jobjectArray roles, jobjectArray contents) {
    std::string out, err;
    if (!kula::applyTemplate(jstrs(env, roles), jstrs(env, contents), out, err)) { throwRuntime(env, err); return nullptr; }
    return env->NewStringUTF(out.c_str());
}

struct TokenSink {
    JNIEnv* env;
    jobject cb;
    jmethodID invoke;
};

static void onPiece(const char* piece, void* user) {
    auto* s = static_cast<TokenSink*>(user);
    jstring js = s->env->NewStringUTF(piece);
    s->env->CallObjectMethod(s->cb, s->invoke, js);
    s->env->DeleteLocalRef(js);
}

// Streams pieces to cb.invoke(String). Returns the number of generated tokens, or -1 when
// stopped before the first token. Blocks; call it off the main thread.
static jint nGenerate(JNIEnv* env, jclass, jstring jprompt, jint max_tokens, jfloat temperature,
                      jfloat top_p, jint top_k, jfloat min_p, jfloat repeat_penalty, jint seed, jobject cb) {
    jclass cbClass = env->GetObjectClass(cb);
    TokenSink sink{env, cb, env->GetMethodID(cbClass, "invoke", "(Ljava/lang/Object;)Ljava/lang/Object;")};
    std::string err;
    const int n = kula::generate(jstr(env, jprompt), max_tokens, temperature, top_p, top_k, min_p, repeat_penalty, seed, onPiece, &sink, err);
    env->DeleteLocalRef(cbClass);
    if (n == -2) { throwRuntime(env, err); return -1; }
    return n;
}

static void nStop(JNIEnv*, jclass) { kula::stop(); }
static jint nTokensUsed(JNIEnv*, jclass) { return kula::tokensUsed(); }
static jint nContextSize(JNIEnv*, jclass) { return kula::contextSize(); }
static void nClearContext(JNIEnv*, jclass) { kula::clearContext(); }

static jstring nLastLoadBuffers(JNIEnv* env, jclass) { return env->NewStringUTF(kula::lastLoadBuffers().c_str()); }

static jstring nWorkerPeer(JNIEnv* env, jclass) {
    const std::string peer = kula::workerPeer();
    return peer.empty() ? nullptr : env->NewStringUTF(peer.c_str());
}

static jdouble nMemBandwidth(JNIEnv*, jclass, jint threads) { return kula::memBandwidth(threads); }

// Runs this device as a worker: blocks for as long as the server runs (ggml can't stop it),
// so it lives in its own process. Returns only when it couldn't start, with the reason.
static jstring nServe(JNIEnv* env, jclass, jstring lib_dir, jstring endpoint, jstring cache_dir, jint n_threads) {
    kula::setLogSink(androidSink);
    const std::string why = kula::serve(jstr(env, lib_dir), jstr(env, endpoint), jstr(env, cache_dir), n_threads);
    return env->NewStringUTF(why.c_str());
}

// --- registration ----------------------------------------------------------------------------

static const JNINativeMethod kNatives[] = {
    {"initBackends", "(Ljava/lang/String;)Z", (void*)nInitBackends},
    {"ggufMeta", "(Ljava/lang/String;)Ljava/lang/String;", (void*)nGgufMeta},
    {"loadModel", "(Ljava/lang/String;II[Ljava/lang/String;[FF)Ljava/lang/String;", (void*)nLoadModel},
    {"freeModel", "()V", (void*)nFreeModel},
    {"isLoaded", "()Z", (void*)nIsLoaded},
    {"applyTemplate", "([Ljava/lang/String;[Ljava/lang/String;)Ljava/lang/String;", (void*)nApplyTemplate},
    {"generate", "(Ljava/lang/String;IFFIFFILkotlin/jvm/functions/Function1;)I", (void*)nGenerate},
    {"stop", "()V", (void*)nStop},
    {"tokensUsed", "()I", (void*)nTokensUsed},
    {"contextSize", "()I", (void*)nContextSize},
    {"clearContext", "()V", (void*)nClearContext},
    {"lastLoadBuffers", "()Ljava/lang/String;", (void*)nLastLoadBuffers},
    {"workerPeer", "()Ljava/lang/String;", (void*)nWorkerPeer},
    {"memBandwidth", "(I)D", (void*)nMemBandwidth},
    {"serve", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I)Ljava/lang/String;", (void*)nServe},
};

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    kula::setLogSink(androidSink);
    jclass cls = env->FindClass("expo/modules/kulallama/Native");
    if (!cls) return JNI_ERR;
    if (env->RegisterNatives(cls, kNatives, sizeof(kNatives) / sizeof(kNatives[0])) != JNI_OK) return JNI_ERR;
    return JNI_VERSION_1_6;
}
