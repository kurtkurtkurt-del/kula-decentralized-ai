// libFuzzer target for kula_gguf_meta (gguf_meta.h): the bytes are the whole file a phone
// might have downloaded. gguf only reads from a path, so the input goes into a memfd and
// is read back through /proc/self/fd. Any crash, abort (GGML_ASSERT) or leak the sanitizer
// finds is a bug in the header reader or in gguf itself.
//
//   cmake -S .. -B build-fuzz -DKULA_FUZZ=ON -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++
//   cmake --build build-fuzz --target gguf_meta_fuzz
//   ./build-fuzz/gguf_meta_fuzz corpus/ -max_len=65536
//
// corpus/ holds small valid and broken headers (make-corpus.mjs writes them).
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <sys/mman.h>
#include <unistd.h>
#include "../gguf_meta.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    const int fd = memfd_create("gguf", 0);
    if (fd < 0) return 0;
    size_t off = 0;
    while (off < size) {
        const ssize_t n = write(fd, data + off, size - off);
        if (n <= 0) { close(fd); return 0; }
        off += static_cast<size_t>(n);
    }
    char path[64];
    snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
    std::string out;
    const bool ok = kula_gguf_meta(path, out);
    // a readable file always names its arch line first; an unreadable one gives nothing
    if (ok && out.compare(0, 5, "arch\t") != 0) __builtin_trap();
    if (!ok && !out.empty()) __builtin_trap();
    close(fd);
    return 0;
}
