#include "chat.h"
#include "ggml-backend.h"
#include "llama.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <iostream>
#include <map>
#include <mutex>
#include <queue>
#include <set>
#include <thread>
using json = nlohmann::ordered_json;
static std::atomic<bool> cancelled{false};
static void log_callback(ggml_log_level, const char *text, void *) {
  std::cerr << text;
}
struct Engine {
  llama_model *model = nullptr;
  llama_context *ctx = nullptr;
  const llama_vocab *vocab = nullptr;
  common_chat_templates_ptr templates;
  std::string runtime_file;
  int max_len = 16384, max_batch = 32, max_tokens = 32768;
  int forwards = 0, computed = 0;
  ~Engine() {
    if (ctx)
      llama_free(ctx);
    if (model)
      llama_model_free(model);
    if (!runtime_file.empty())
      std::remove(runtime_file.c_str());
  }
  std::vector<llama_token> tokenize(const std::string &s) {
    int n = llama_tokenize(vocab, s.data(), s.size(), nullptr, 0, false, true);
    if (n == 0)
      return {};
    std::vector<llama_token> t(-n);
    n = llama_tokenize(vocab, s.data(), s.size(), t.data(), t.size(), false,
                       true);
    if (n < 0)
      throw std::runtime_error("Tokenization failed");
    t.resize(n);
    return t;
  }
  void init(const json &r) {
    if (model)
      throw std::runtime_error("Already initialized");
    max_len = r.value("max_model_len", 16384);
    max_batch = r.value("max_batch_size", 32);
    max_tokens = r.value("max_batch_tokens", 32768);
    if (max_len < 1 || max_len > 32768 || max_batch < 1 || max_batch > 256 ||
        max_tokens < 1 || max_tokens > 131072)
      throw std::runtime_error("Invalid native limits");
    auto mp = llama_model_default_params();
    const auto device = r.value("device", std::string("auto"));
    if (device != "cpu" && device != "auto" && device != "metal")
      throw std::runtime_error("Unsupported device");
    ggml_backend_dev_t metal = nullptr;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
      auto dev = ggml_backend_dev_get(i);
      if (std::string(ggml_backend_reg_name(
              ggml_backend_dev_backend_reg(dev))) == "MTL") {
        metal = dev;
        break;
      }
    }
    if (device == "metal" && !metal)
      throw std::runtime_error("Metal device unavailable");
    const bool cpu = device == "cpu" || (device == "auto" && !metal);
    mp.n_gpu_layers = cpu ? 0 : 99;
    ggml_backend_dev_t devices[] = {metal, nullptr};
    if (!cpu)
      mp.devices = devices;
    auto model_file = r.at("model_file").get<std::string>();
    if (cpu) {
      runtime_file = r.at("runtime_file").get<std::string>();
      auto qp = llama_model_quantize_default_params();
      qp.ftype = LLAMA_FTYPE_ALL_F32;
      qp.nthread = 4;
      qp.output_tensor_type = GGML_TYPE_F32;
      qp.token_embedding_type = GGML_TYPE_F32;
      if (llama_model_quantize(model_file.c_str(), runtime_file.c_str(), &qp))
        throw std::runtime_error("CPU F32 weight expansion failed");
      model_file = runtime_file;
    }
    model = llama_model_load_from_file(model_file.c_str(), mp);
    if (!model)
      throw std::runtime_error("Model load failed");
    char arch[128]{};
    llama_model_meta_val_str(model, "general.architecture", arch, sizeof(arch));
    if (std::string(arch) != "gemma3")
      throw std::runtime_error("Expected verified Gemma 3 artifact");
    if (max_len > llama_model_n_ctx_train(model))
      throw std::runtime_error("Context exceeds model limit");
    vocab = llama_model_get_vocab(model);
    if (!llama_model_chat_template(model, nullptr))
      throw std::runtime_error("Missing model chat template");
    templates = common_chat_templates_init(model, "");
    auto cp = llama_context_default_params();
    cp.n_ctx = max_len + max_tokens;
    cp.n_batch = 4096;
    cp.n_ubatch = 512;
    cp.n_seq_max = max_batch + 1;
    cp.kv_unified = true;
    cp.type_k = GGML_TYPE_F32;
    cp.type_v = GGML_TYPE_F32;
    cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
    cp.n_threads = 4;
    cp.n_threads_batch = 4;
    ctx = llama_init_from_model(model, cp);
    if (!ctx)
      throw std::runtime_error("Context initialization failed");
  }
  json compile(const json &branches) {
    if (!branches.is_array() || branches.empty() || branches.size() > 256)
      throw std::invalid_argument("Expected 1–256 branches");
    json result = json::array();
    for (const auto &b : branches) {
      common_chat_templates_inputs input;
      input.enable_thinking = false;
      input.add_generation_prompt = true;
      input.add_bos = true;
      input.add_eos = false;
      for (const auto &m : b.at("messages")) {
        common_chat_msg msg;
        msg.role = m.at("role");
        msg.content = m.at("content");
        if (msg.role != "user" && msg.role != "assistant" &&
            msg.role != "system")
          throw std::invalid_argument("Gemma does not support this role");
        input.messages.push_back(msg);
      }
      std::string prompt;
      try {
        prompt = common_chat_templates_apply(templates.get(), input).prompt +
                 b.at("answer_prefix").get<std::string>();
      } catch (const std::exception &e) {
        throw std::invalid_argument(std::string("Unsupported chat history: ") +
                                    e.what());
      }
      if (prompt.rfind("<bos>", 0) != 0)
        prompt = "<bos>" + prompt;
      auto tokens = tokenize(prompt);
      if (tokens.empty() || tokens.size() > size_t(max_len))
        throw std::invalid_argument("Branch exceeds context limit");
      json ids = json::object();
      std::set<llama_token> distinct;
      for (const auto &label : b.at("output_labels")) {
        auto with = tokenize(prompt + label.get<std::string>());
        if (with.size() != tokens.size() + 1 ||
            !std::equal(tokens.begin(), tokens.end(), with.begin()) ||
            !distinct.insert(with.back()).second)
          throw std::invalid_argument(
              "Answer label is not one distinct token at rendered boundary");
        ids[label.get<std::string>()] = with.back();
      }
      result.push_back({{"branch_id", b.at("branch_id")},
                        {"tokens", tokens},
                        {"token_ids", ids},
                        {"rendered", prompt}});
    }
    return result;
  }
  void decode(const std::vector<llama_token> &tokens, int seq, int offset,
              bool output) {
    for (size_t start = 0; start < tokens.size(); start += 4096) {
      if (cancelled)
        throw std::runtime_error("Cancelled");
      const size_t n = std::min(size_t(4096), tokens.size() - start);
      auto batch = llama_batch_init(n, 0, 1);
      for (size_t i = 0; i < n; i++) {
        batch.token[i] = tokens[start + i];
        batch.pos[i] = offset + start + i;
        batch.n_seq_id[i] = 1;
        batch.seq_id[i][0] = seq;
        batch.logits[i] = output && start + i + 1 == tokens.size();
      }
      batch.n_tokens = n;
      int code = llama_decode(ctx, batch);
      llama_batch_free(batch);
      if (code)
        throw std::runtime_error("Native forward failed: " +
                                 std::to_string(code));
      forwards++;
      computed += n;
    }
  }
  json evaluate(const json &branches, bool full) {
    if (!branches.is_array() || branches.empty() || branches.size() > 256)
      throw std::invalid_argument("Expected 1–256 compiled branches");
    for (const auto &b : branches) {
      auto t = b.at("tokens").get<std::vector<llama_token>>();
      if (t.empty() || t.size() > size_t(max_len))
        throw std::invalid_argument("Invalid compiled token length");
      for (auto token : t)
        if (token < 0 || token >= llama_vocab_n_tokens(vocab))
          throw std::invalid_argument("Invalid compiled token ID");
      if (!b.at("token_ids").is_object() || b.at("token_ids").empty())
        throw std::invalid_argument("Missing answer token IDs");
      for (auto it = b.at("token_ids").begin(); it != b.at("token_ids").end();
           it++) {
        int token = it.value().get<int>();
        if (token < 0 || token >= llama_vocab_n_tokens(vocab))
          throw std::invalid_argument("Invalid answer token ID");
      }
    }
    llama_memory_clear(llama_get_memory(ctx), true);
    forwards = 0;
    computed = 0;
    std::vector<std::vector<llama_token>> tokens;
    for (const auto &b : branches)
      tokens.push_back(b.at("tokens").get<std::vector<llama_token>>());
    size_t prefix = 0;
    if (!full) {
      size_t cap = tokens[0].size() - 1;
      for (auto &t : tokens)
        cap = std::min(cap, t.size() - 1);
      while (prefix < cap) {
        bool same = true;
        for (auto &t : tokens)
          if (t[prefix] != tokens[0][prefix])
            same = false;
        if (!same)
          break;
        prefix++;
      }
    }
    if (prefix)
      decode({tokens[0].begin(), tokens[0].begin() + prefix}, 0, 0, false);
    std::vector<size_t> order;
    for (size_t i = 0; i < tokens.size(); i++)
      order.push_back(i);
    std::stable_sort(order.begin(), order.end(), [&](auto a, auto b) {
      return tokens[a].size() < tokens[b].size();
    });
    json logits = json::object(), sizes = json::array();
    for (size_t cursor = 0; cursor < order.size();) {
      if (cancelled)
        throw std::runtime_error("Cancelled");
      size_t end = cursor;
      while (end < order.size() &&
             end - cursor < size_t(full ? 1 : max_batch) &&
             (end - cursor + 1) * (tokens[order[end]].size() - prefix) <=
                 size_t(max_tokens))
        end++;
      if (end == cursor)
        throw std::invalid_argument("Suffix exceeds batch token budget");
      sizes.push_back(end - cursor);
      auto batch = llama_batch_init(max_tokens, 0, 1);
      std::vector<int> last;
      for (size_t j = cursor; j < end; j++) {
        int seq = j - cursor + 1;
        auto i = order[j];
        if (prefix)
          llama_memory_seq_cp(llama_get_memory(ctx), 0, seq, 0, prefix);
        for (size_t k = prefix; k < tokens[i].size(); k++) {
          int n = batch.n_tokens++;
          batch.token[n] = tokens[i][k];
          batch.pos[n] = k;
          batch.n_seq_id[n] = 1;
          batch.seq_id[n][0] = seq;
          batch.logits[n] = k + 1 == tokens[i].size();
        }
        last.push_back(batch.n_tokens - 1);
      }
      // Split large suffix batches into native calls while preserving scoring
      // positions.
      for (int start = 0; start < batch.n_tokens; start += 4096) {
        if (cancelled) {
          llama_batch_free(batch);
          throw std::runtime_error("Cancelled");
        }
        int n = std::min(4096, batch.n_tokens - start);
        llama_batch part = batch;
        part.n_tokens = n;
        part.token += start;
        part.pos += start;
        part.n_seq_id += start;
        part.seq_id += start;
        part.logits += start;
        int code = llama_decode(ctx, part);
        if (code) {
          llama_batch_free(batch);
          throw std::runtime_error("Native suffix forward failed: " +
                                   std::to_string(code));
        }
        forwards++;
        computed += n;
        for (size_t j = 0; j < last.size(); j++)
          if (last[j] >= start && last[j] < start + n) {
            auto i = order[cursor + j];
            auto row = llama_get_logits_ith(ctx, last[j] - start);
            if (!row) {
              llama_batch_free(batch);
              throw std::runtime_error("Missing scoring logits");
            }
            json selected = json::object();
            for (auto it = branches[i].at("token_ids").begin();
                 it != branches[i].at("token_ids").end(); it++) {
              float v = row[it.value().get<int>()];
              if (!std::isfinite(v)) {
                llama_batch_free(batch);
                throw std::runtime_error("Non-finite selected logit");
              }
              selected[it.key()] = v;
            }
            logits[branches[i].at("branch_id").get<std::string>()] = selected;
          }
      }
      llama_batch_free(batch);
      for (size_t j = cursor; j < end; j++)
        llama_memory_seq_rm(llama_get_memory(ctx), j - cursor + 1, -1, -1);
      cursor = end;
    }
    // Logical unique-prefix accounting is independent of executed batches.
    std::map<std::pair<int, llama_token>, int> trie;
    int lengths = 0;
    for (auto &t : tokens) {
      lengths += t.size();
      int node = 0;
      for (auto token : t) {
        auto key = std::make_pair(node, token);
        auto found = trie.find(key);
        if (found == trie.end())
          found = trie.emplace(key, trie.size() + 1).first;
        node = found->second;
      }
    }
    llama_memory_clear(llama_get_memory(ctx), true);
    return {{"logits", logits},
            {"input_tokens", trie.size()},
            {"metrics",
             {{"backend", "llama.cpp"},
              {"prefill_strategy", full ? "full" : "shared_prefix"},
              {"prefix_tokens", prefix},
              {"suffix_batch_sizes", sizes},
              {"engine_forwards", forwards},
              {"branch_prompt_tokens", lengths},
              {"computed_prompt_tokens", computed},
              {"logical_prefill_tokens", computed},
              {"padded_suffix_tokens", 0},
              {"branch_output_tokens", 0},
              {"scored_positions", tokens.size()}}}};
  }
};
int main() {
  llama_log_set(log_callback, nullptr);
  ggml_backend_load_all();
  llama_backend_init();
  Engine engine;
  std::mutex mutex;
  std::condition_variable cv;
  std::queue<json> requests;
  bool eof = false;
  std::string active;
  std::set<std::string> cancelled_requests;
  std::thread reader([&] {
    std::string line;
    while (std::getline(std::cin, line)) {
      try {
        auto r = json::parse(line);
        std::lock_guard<std::mutex> lock(mutex);
        if (r.value("op", "") == "cancel") {
          if (r.value("target", "") == active)
            cancelled = true;
          else
            cancelled_requests.insert(r.value("target", ""));
        } else
          requests.push(r);
        cv.notify_one();
      } catch (...) {
      }
    }
    {
      std::lock_guard<std::mutex> lock(mutex);
      eof = true;
    }
    cv.notify_one();
  });
  while (true) {
    json r;
    {
      std::unique_lock<std::mutex> lock(mutex);
      cv.wait(lock, [&] { return eof || !requests.empty(); });
      if (requests.empty())
        break;
      r = requests.front();
      requests.pop();
      active = r.value("id", "");
      cancelled = cancelled_requests.erase(active) > 0;
    }
    json response = {{"v", 1}, {"id", r.value("id", "")}};
    try {
      if (r.value("v", 0) != 1)
        throw std::invalid_argument("Unsupported protocol");
      const auto op = r.value("op", "");
      if (op == "init") {
        engine.init(r);
        response["result"] = {
            {"ready", true},
            {"template", common_chat_templates_source(engine.templates.get())}};
      } else {
        if (!engine.ctx)
          throw std::runtime_error("Not initialized");
        if (op == "compile")
          response["result"] = engine.compile(r.at("branches"));
        else if (op == "evaluate")
          response["result"] =
              engine.evaluate(r.at("branches"), r.value("full", false));
        else
          throw std::invalid_argument("Unknown operation");
      }
    } catch (const std::invalid_argument &e) {
      if (engine.ctx)
        llama_memory_clear(llama_get_memory(engine.ctx), true);
      response["error"] = {{"message", e.what()}, {"kind", "invalid_request"}};
    } catch (const std::exception &e) {
      if (engine.ctx)
        llama_memory_clear(llama_get_memory(engine.ctx), true);
      response["error"] = {{"message", e.what()},
                           {"kind", cancelled ? "cancelled" : "runtime"}};
    }
    std::cout << response.dump() << std::endl;
    {
      std::lock_guard<std::mutex> lock(mutex);
      active.clear();
    }
  }
  reader.join();
  return 0;
}
