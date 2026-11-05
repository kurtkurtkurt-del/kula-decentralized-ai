// The GGUF header fields kula shows and plans with, as one tab separated text:
//   arch\tllama\nlayers\t32\nctx\t8192\n ... template\t1\n
// Shared by the JNI entry point (kula_llama.cpp nGgufMeta) and the fuzz target
// (fuzz/gguf_meta_fuzz.cpp), so what the fuzzer exercises is what the app runs.
// Only typed reads: a key of an unexpected type is skipped, never asserted on, because
// gguf_get_val_str and friends abort the whole process on a type mismatch and a
// downloaded file is not something to trust with that.
#pragma once
#include <cstdint>
#include <string>
#include "gguf.h"

// Returns false when the file is not a readable GGUF (gguf_init_from_file refused it).
inline bool kula_gguf_meta(const char* path, std::string& out) {
    out.clear();
    gguf_init_params params = {true, nullptr};
    gguf_context* gguf = gguf_init_from_file(path, params);
    if (!gguf) return false;
    auto put = [&](const char* name, const std::string& v) { out.append(name).append("\t").append(v).append("\n"); };
    auto str_at = [&](int64_t id) -> std::string {
        if (id < 0 || gguf_get_kv_type(gguf, id) != GGUF_TYPE_STRING) return "";
        const char* s = gguf_get_val_str(gguf, id);
        return s ? std::string(s) : "";
    };
    const int64_t arch_id = gguf_find_key(gguf, "general.architecture");
    const std::string arch = str_at(arch_id);
    put("arch", arch);
    auto num = [&](const char* suffix, const char* name) {
        const int64_t id = gguf_find_key(gguf, (arch + "." + suffix).c_str());
        if (id < 0) return;
        switch (gguf_get_kv_type(gguf, id)) {
            case GGUF_TYPE_UINT32: put(name, std::to_string(gguf_get_val_u32(gguf, id))); break;
            case GGUF_TYPE_INT32: put(name, std::to_string(gguf_get_val_i32(gguf, id))); break;
            case GGUF_TYPE_UINT64: put(name, std::to_string(gguf_get_val_u64(gguf, id))); break;
            default: break;
        }
    };
    num("block_count", "layers");
    num("context_length", "ctx");
    num("embedding_length", "embd");
    num("attention.head_count", "heads");
    num("attention.head_count_kv", "heads_kv");
    num("attention.key_length", "key_len");
    num("attention.value_length", "value_len");
    for (const char* k : {"general.name", "general.license", "general.size_label", "general.file_type"}) {
        const int64_t id = gguf_find_key(gguf, k);
        if (id < 0) continue;
        const gguf_type t = gguf_get_kv_type(gguf, id);
        if (t == GGUF_TYPE_STRING) put(k + 8, str_at(id));
        else if (t == GGUF_TYPE_UINT32) put(k + 8, std::to_string(gguf_get_val_u32(gguf, id)));
    }
    put("template", gguf_find_key(gguf, "tokenizer.chat_template") >= 0 ? "1" : "0");
    gguf_free(gguf);
    return true;
}
