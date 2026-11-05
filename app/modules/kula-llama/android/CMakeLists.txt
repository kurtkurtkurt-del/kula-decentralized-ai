cmake_minimum_required(VERSION 3.22.1)
project(kula_llama)

# llama.cpp for kula, arm64 only. After PrivateLM's build (MIT), without Vulkan and mtmd.
# Backends are separate .so modules loaded at runtime (see kula_llama.cpp):
#  - libggml-cpu-android_armv*.so, one per Arm generation
#  - libggml-rpc.so, the phone cluster (a worker serves its CPU; a master spreads layers)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -Wl,-z,max-page-size=16384")
set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} -Wl,-z,max-page-size=16384")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O3")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3")

set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_AARCH64 ON CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
# KULA_CPU_VARIANTS=min builds one CPU variant for a quick development loop.
if(KULA_CPU_VARIANTS STREQUAL "min")
  set(GGML_CPU_ALL_VARIANTS OFF CACHE BOOL "" FORCE)
else()
  set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
endif()
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
set(GGML_RPC ON CACHE BOOL "" FORCE)
set(GGML_RPC_RDMA OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_STATIC OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_MTMD OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)

add_subdirectory(src/main/cpp/llama.cpp)

# standalone shared objects with C++ inside need libc++ explicitly on the NDK
foreach(target ggml-base ggml ggml-cpu ggml-rpc llama
        ggml-cpu-android_armv8.0_1 ggml-cpu-android_armv8.2_1 ggml-cpu-android_armv8.2_2
        ggml-cpu-android_armv8.6_1 ggml-cpu-android_armv9.0_1 ggml-cpu-android_armv9.2_1
        ggml-cpu-android_armv9.2_2)
  if(TARGET ${target})
    target_link_libraries(${target} PRIVATE c++_shared)
  endif()
endforeach()

# the platform-free core is shared with ios/ (cpp/core); this file is the JNI over it
add_library(kula_llama SHARED src/main/cpp/kula_llama.cpp ../cpp/core/kula_core.cpp)
target_link_libraries(kula_llama llama ggml c++_shared android log dl)
target_compile_definitions(kula_llama PRIVATE KULA_BACKEND_DL=1)
target_include_directories(kula_llama PRIVATE
  ../cpp/core
  src/main/cpp/llama.cpp/include
  src/main/cpp/llama.cpp/ggml/include)
