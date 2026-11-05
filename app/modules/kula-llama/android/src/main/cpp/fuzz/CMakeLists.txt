# The fuzz targets: off by default (KULA_FUZZ=ON), built with clang's libFuzzer and
# AddressSanitizer against the gguf reader in ggml-base. Not part of the Android build.
if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  message(FATAL_ERROR "KULA_FUZZ needs clang (libFuzzer); got ${CMAKE_CXX_COMPILER_ID}")
endif()
add_executable(gguf_meta_fuzz gguf_meta_fuzz.cpp)
target_compile_options(gguf_meta_fuzz PRIVATE -fsanitize=fuzzer,address,undefined -g -O1 -fno-omit-frame-pointer)
target_link_options(gguf_meta_fuzz PRIVATE -fsanitize=fuzzer,address,undefined)
target_link_libraries(gguf_meta_fuzz PRIVATE ggml-base)
target_include_directories(gguf_meta_fuzz PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../llama.cpp/ggml/include)
# the same input run once over the corpus, without the fuzzing engine: a plain regression check
add_executable(gguf_meta_corpus gguf_meta_fuzz.cpp corpus_main.cpp)
target_compile_options(gguf_meta_corpus PRIVATE -fsanitize=address,undefined -g -O1 -fno-omit-frame-pointer)
target_link_options(gguf_meta_corpus PRIVATE -fsanitize=address,undefined)
target_link_libraries(gguf_meta_corpus PRIVATE ggml-base)
target_include_directories(gguf_meta_corpus PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../llama.cpp/ggml/include)
