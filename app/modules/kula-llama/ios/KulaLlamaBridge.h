// The Objective-C face of cpp/core (kula_core.h) for the Swift module. Pure ObjC here so
// the pod's umbrella header (and Swift) can read it; the C++ stays in the .mm.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^KulaTokenBlock)(NSString *piece);

@interface KulaLoadInfo : NSObject
@property(nonatomic) NSInteger localLayers;
@property(nonatomic) NSInteger layers;
@property(nonatomic) NSInteger ctx;
@end

@interface KulaLlamaBridge : NSObject

/** Registers the backends linked in (CPU, Metal, RPC). Idempotent. */
+ (BOOL)initBackends;
/** "key\tvalue\n" lines of the GGUF header, nil when the file is not a GGUF. */
+ (nullable NSString *)ggufMeta:(NSString *)path;
/** endpoints are "host:port" RPC workers already probed; nil + error with the core's reason on failure. */
+ (nullable KulaLoadInfo *)loadModel:(NSString *)path
                             threads:(NSInteger)threads
                                 ctx:(NSInteger)ctx
                           endpoints:(NSArray<NSString *> *)endpoints
                             weights:(NSArray<NSNumber *> *)weights
                         localWeight:(float)localWeight
                               error:(NSError **)error;
+ (void)freeModel;
+ (BOOL)isLoaded;
+ (nullable NSString *)applyTemplate:(NSArray<NSString *> *)roles contents:(NSArray<NSString *> *)contents error:(NSError **)error;
/**
 * Blocks; streams pieces to onToken. Returns generated tokens, -1 when stopped before the
 * first token; on an error returns -1 and sets error.
 */
+ (NSInteger)generate:(NSString *)prompt
            maxTokens:(NSInteger)maxTokens
          temperature:(float)temperature
                 topP:(float)topP
                 topK:(NSInteger)topK
                 minP:(float)minP
        repeatPenalty:(float)repeatPenalty
                 seed:(NSInteger)seed
              onToken:(KulaTokenBlock)onToken
                error:(NSError **)error;
+ (void)stop;
+ (NSInteger)tokensUsed;
+ (NSInteger)contextSize;
+ (void)clearContext;
/** "<buffer>\t<MiB>\n" per weight buffer of the last load. */
+ (NSString *)lastLoadBuffers;
/** The master connected to this worker right now, or nil. */
+ (nullable NSString *)workerPeer;
+ (double)memBandwidth:(NSInteger)threads;
/** Blocks for the life of the RPC server; returns the reason when it could not start. */
+ (NSString *)serve:(NSString *)endpoint cacheDir:(NSString *)cacheDir threads:(NSInteger)threads;

@end

NS_ASSUME_NONNULL_END
