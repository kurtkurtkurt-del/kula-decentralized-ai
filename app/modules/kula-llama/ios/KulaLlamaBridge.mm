#import "KulaLlamaBridge.h"
#import <os/log.h>
#include <string>
#include <vector>
#include "kula_core.h"

static os_log_t kulaLogger() {
    static os_log_t log = os_log_create("app.kula.llama", "core");
    return log;
}

static void appleSink(kula::LogLevel level, const char* text) {
    os_log_with_type(kulaLogger(), level == kula::LogLevel::Error ? OS_LOG_TYPE_ERROR : level == kula::LogLevel::Warn ? OS_LOG_TYPE_DEFAULT : OS_LOG_TYPE_INFO,
                     "%{public}s", text);
}

static NSError* kulaError(const std::string& why) {
    return [NSError errorWithDomain:@"KulaLlama" code:1 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithUTF8String:why.c_str()] ?: @"failed"}];
}

static std::string str(NSString* s) { return s ? std::string([s UTF8String]) : std::string(); }
static std::vector<std::string> strs(NSArray<NSString*>* a) {
    std::vector<std::string> out;
    for (NSString* s in a) out.push_back(str(s));
    return out;
}

@implementation KulaLoadInfo
@end

@implementation KulaLlamaBridge

+ (void)initialize {
    if (self == [KulaLlamaBridge class]) kula::setLogSink(appleSink);
}

+ (BOOL)initBackends {
    return kula::initBackends("");
}

+ (NSString*)ggufMeta:(NSString*)path {
    std::string out;
    if (!kula::ggufMeta(str(path), out)) return nil;
    return [NSString stringWithUTF8String:out.c_str()];
}

+ (KulaLoadInfo*)loadModel:(NSString*)path threads:(NSInteger)threads ctx:(NSInteger)ctx endpoints:(NSArray<NSString*>*)endpoints
                   weights:(NSArray<NSNumber*>*)weights localWeight:(float)localWeight error:(NSError**)error {
    std::vector<float> ws;
    for (NSNumber* w in weights) ws.push_back(w.floatValue);
    kula::LoadResult r;
    std::string err;
    if (!kula::loadModel(str(path), (int)threads, (int)ctx, strs(endpoints), ws, localWeight, r, err)) {
        if (error) *error = kulaError(err);
        return nil;
    }
    KulaLoadInfo* info = [KulaLoadInfo new];
    info.localLayers = r.local_layers;
    info.layers = r.layers;
    info.ctx = r.n_ctx;
    return info;
}

+ (void)freeModel { kula::freeModel(); }
+ (BOOL)isLoaded { return kula::isLoaded(); }

+ (NSString*)applyTemplate:(NSArray<NSString*>*)roles contents:(NSArray<NSString*>*)contents error:(NSError**)error {
    std::string out, err;
    if (!kula::applyTemplate(strs(roles), strs(contents), out, err)) {
        if (error) *error = kulaError(err);
        return nil;
    }
    return [NSString stringWithUTF8String:out.c_str()];
}

static void onPiece(const char* piece, void* user) {
    KulaTokenBlock block = (__bridge KulaTokenBlock)user;
    NSString* s = [NSString stringWithUTF8String:piece];
    if (s) block(s);
}

+ (NSInteger)generate:(NSString*)prompt maxTokens:(NSInteger)maxTokens temperature:(float)temperature topP:(float)topP topK:(NSInteger)topK
                 minP:(float)minP repeatPenalty:(float)repeatPenalty seed:(NSInteger)seed onToken:(KulaTokenBlock)onToken error:(NSError**)error {
    std::string err;
    const int n = kula::generate(str(prompt), (int)maxTokens, temperature, topP, (int)topK, minP, repeatPenalty, (int)seed,
                                 onPiece, (__bridge void*)onToken, err);
    if (n == -2) {
        if (error) *error = kulaError(err);
        return -1;
    }
    return n;
}

+ (void)stop { kula::stop(); }
+ (NSInteger)tokensUsed { return kula::tokensUsed(); }
+ (NSInteger)contextSize { return kula::contextSize(); }
+ (void)clearContext { kula::clearContext(); }

+ (NSString*)lastLoadBuffers {
    return [NSString stringWithUTF8String:kula::lastLoadBuffers().c_str()] ?: @"";
}

+ (NSString*)workerPeer {
    const std::string peer = kula::workerPeer();
    return peer.empty() ? nil : [NSString stringWithUTF8String:peer.c_str()];
}

+ (double)memBandwidth:(NSInteger)threads { return kula::memBandwidth((int)threads); }

+ (NSString*)serve:(NSString*)endpoint cacheDir:(NSString*)cacheDir threads:(NSInteger)threads {
    const std::string why = kula::serve("", str(endpoint), str(cacheDir), (int)threads);
    return [NSString stringWithUTF8String:why.c_str()] ?: @"worker stopped";
}

@end
