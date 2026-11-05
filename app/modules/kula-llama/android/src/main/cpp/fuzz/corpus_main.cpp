// Runs LLVMFuzzerTestOneInput over every file given on the command line (the corpus),
// so the broken headers stay a regression test where libFuzzer is not wanted.
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);

int main(int argc, char** argv) {
    int n = 0;
    for (int i = 1; i < argc; i++) {
        std::ifstream f(argv[i], std::ios::binary);
        if (!f) { fprintf(stderr, "cannot read %s\n", argv[i]); return 1; }
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        LLVMFuzzerTestOneInput(bytes.data(), bytes.size());
        n++;
    }
    printf("%d files, no crash\n", n);
    return 0;
}
