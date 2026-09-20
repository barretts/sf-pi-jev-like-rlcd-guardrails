#include "build-info.h"
#include "chat.h"
#include "ggml-backend.h"
#include "llama.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <map>
#include <mutex>
#include <queue>
#include <set>
#include <thread>
using json = nlohmann::ordered_json;
static std::atomic<bool> cancelled{false};
static constexpr size_t max_protocol_line = 64 * 1024 * 1024;
static void check_cancelled() {
  if (cancelled.load())
    throw std::runtime_error("Cancelled");
}
static int integer(const json &value, int low, int high,
                   const char *description) {
  if (!value.is_number_integer())
    throw std::invalid_argument(description);
  if (value.is_number_unsigned()) {
    const auto n = value.get<std::uint64_t>();
    if (n > std::uint64_t(high) || n < std::uint64_t(low))
      throw std::invalid_argument(description);
    return int(n);
  }
  const auto n = value.get<std::int64_t>();
  if (n < low || n > high)
    throw std::invalid_argument(description);
  return int(n);
}
static int limit(const json &request, const char *key, int fallback, int high) {
  return request.contains(key)
             ? integer(request.at(key), 1, high, "Invalid native limits")
             : fallback;
}
struct NativeBatch {
  llama_batch value;
  explicit NativeBatch(int size) : value(llama_batch_init(size, 0, 1)) {}
  ~NativeBatch() { llama_batch_free(value); }
  NativeBatch(const NativeBatch &) = delete;
  NativeBatch &operator=(const NativeBatch &) = delete;
};
static void log_callback(ggml_log_level, const char *text, void *) {
  std::cerr << text;
}
struct Engine {
  llama_model *model = nullptr;
  llama_context *ctx = nullptr;
  const llama_vocab *vocab = nullptr;
  common_chat_templates_ptr templates;
  std::string runtime_file;
  std::string device, device_name, architecture;
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
    check_cancelled();
    int n = llama_tokenize(vocab, s.data(), s.size(), nullptr, 0, false, true);
    check_cancelled();
    if (n == 0)
      return {};
    std::vector<llama_token> t(-n);
    n = llama_tokenize(vocab, s.data(), s.size(), t.data(), t.size(), false,
                       true);
    check_cancelled();
    if (n < 0)
      throw std::runtime_error("Tokenization failed");
    t.resize(n);
    return t;
  }
  void init(const json &r) {
    check_cancelled();
    if (model)
      throw std::runtime_error("Already initialized");
    max_len = limit(r, "max_model_len", 16384, 32768);
    max_batch = limit(r, "max_batch_size", 32, 256);
    max_tokens = limit(r, "max_batch_tokens", 32768, 131072);
    auto mp = llama_model_default_params();
    const auto requested_device = r.value("device", std::string("auto"));
    if (requested_device != "cpu" && requested_device != "auto" &&
        requested_device != "metal")
      throw std::invalid_argument("Unsupported device");
    ggml_backend_dev_t metal = nullptr;
    ggml_backend_dev_t host = nullptr;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
      auto dev = ggml_backend_dev_get(i);
      if (ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_CPU)
        host = dev;
      if (std::string(ggml_backend_reg_name(
              ggml_backend_dev_backend_reg(dev))) == "MTL") {
        metal = dev;
      }
    }
    if (requested_device == "metal" && !metal)
      throw std::runtime_error("Metal device unavailable");
    const bool cpu = requested_device == "cpu" ||
                     (requested_device == "auto" && !metal);
    device = cpu ? "cpu" : "metal";
    auto selected_device = cpu ? host : metal;
    device_name = selected_device ? ggml_backend_dev_name(selected_device)
                                  : "CPU";
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
      check_cancelled();
      model_file = runtime_file;
    }
    model = llama_model_load_from_file(model_file.c_str(), mp);
    check_cancelled();
    if (!model)
      throw std::runtime_error("Model load failed");
    char arch[128]{};
    llama_model_meta_val_str(model, "general.architecture", arch, sizeof(arch));
    architecture = arch;
    if (architecture != "gemma3")
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
    check_cancelled();
    if (!ctx)
      throw std::runtime_error("Context initialization failed");
  }
  json status() const {
    return {{"ready", true},
            {"template", common_chat_templates_source(templates.get())},
            {"device", device},
            {"device_name", device_name},
            {"architecture", architecture},
            {"native_build",
             {{"commit", llama_commit()},
              {"target", llama_build_target()},
              {"number", llama_build_number()},
              {"compiler", llama_compiler()}}},
            {"limits",
             {{"max_model_len", max_len},
              {"max_batch_size", max_batch},
              {"max_batch_tokens", max_tokens}}}};
  }
  json compile(const json &branches) {
    check_cancelled();
    if (!branches.is_array() || branches.empty() || branches.size() > 256)
      throw std::invalid_argument("Expected 1–256 branches");
    json result = json::array();
    std::set<std::string> branch_ids;
    for (const auto &b : branches) {
      check_cancelled();
      const auto branch_id = b.at("branch_id").get<std::string>();
      if (branch_id.empty() || !branch_ids.insert(branch_id).second)
        throw std::invalid_argument("Empty or duplicate branch ID");
      if (!b.at("messages").is_array() || b.at("messages").empty() ||
          !b.at("output_labels").is_array() ||
          b.at("output_labels").empty() || b.at("output_labels").size() > 50)
        throw std::invalid_argument("Invalid messages or output labels");
      common_chat_templates_inputs input;
      input.enable_thinking = false;
      input.add_generation_prompt = true;
      input.add_bos = true;
      input.add_eos = false;
      const auto &messages = b.at("messages");
      for (size_t message_index = 0; message_index < messages.size();
           message_index++) {
        check_cancelled();
        const auto &m = messages[message_index];
        common_chat_msg msg;
        msg.role = m.at("role");
        msg.content = m.at("content");
        if (msg.role != "user" && msg.role != "assistant" &&
            msg.role != "system")
          throw std::invalid_argument("Gemma does not support this role");
        // The logical compiler appends the selected question as a user
        // message. Render it in the existing final user turn when necessary;
        // earlier history keeps its roles so unsupported sequences still fail.
        if (message_index + 1 == messages.size() && msg.role == "user" &&
            !input.messages.empty() && input.messages.back().role == "user")
          input.messages.back().content += "\n\n" + msg.content;
        else
          input.messages.push_back(msg);
      }
      std::string prompt;
      check_cancelled();
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
        check_cancelled();
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
    check_cancelled();
    return result;
  }
  void decode(const std::vector<llama_token> &tokens, int seq, int offset,
              bool output) {
    for (size_t start = 0; start < tokens.size(); start += 4096) {
      check_cancelled();
      const size_t n = std::min(size_t(4096), tokens.size() - start);
      NativeBatch owner(n);
      auto &batch = owner.value;
      for (size_t i = 0; i < n; i++) {
        check_cancelled();
        batch.token[i] = tokens[start + i];
        batch.pos[i] = offset + start + i;
        batch.n_seq_id[i] = 1;
        batch.seq_id[i][0] = seq;
        batch.logits[i] = output && start + i + 1 == tokens.size();
      }
      batch.n_tokens = n;
      check_cancelled();
      int code = llama_decode(ctx, batch);
      check_cancelled();
      if (code)
        throw std::runtime_error("Native forward failed: " +
                                 std::to_string(code));
      forwards++;
      computed += n;
    }
  }
  json evaluate(const json &branches, bool full) {
    check_cancelled();
    if (!branches.is_array() || branches.empty() || branches.size() > 256)
      throw std::invalid_argument("Expected 1–256 compiled branches");
    std::set<std::string> branch_ids;
    std::vector<std::vector<llama_token>> tokens;
    for (const auto &b : branches) {
      check_cancelled();
      const auto branch_id = b.at("branch_id").get<std::string>();
      if (branch_id.empty() || !branch_ids.insert(branch_id).second)
        throw std::invalid_argument("Empty or duplicate branch ID");
      const auto &raw = b.at("tokens");
      if (!raw.is_array() || raw.empty() || raw.size() > size_t(max_len))
        throw std::invalid_argument("Invalid compiled token length");
      std::vector<llama_token> t;
      t.reserve(raw.size());
      for (const auto &token : raw) {
        check_cancelled();
        t.push_back(integer(token, 0, llama_vocab_n_tokens(vocab) - 1,
                            "Invalid compiled token ID"));
      }
      tokens.push_back(std::move(t));
      if (!b.at("token_ids").is_object() || b.at("token_ids").empty() ||
          b.at("token_ids").size() > 50)
        throw std::invalid_argument("Missing answer token IDs");
      for (auto it = b.at("token_ids").begin(); it != b.at("token_ids").end();
           it++) {
        check_cancelled();
        integer(it.value(), 0, llama_vocab_n_tokens(vocab) - 1,
                "Invalid answer token ID");
      }
    }
    check_cancelled();
    llama_memory_clear(llama_get_memory(ctx), true);
    forwards = 0;
    computed = 0;
    size_t prefix = 0;
    if (!full) {
      size_t cap = tokens[0].size() - 1;
      for (auto &t : tokens) {
        check_cancelled();
        cap = std::min(cap, t.size() - 1);
      }
      while (prefix < cap) {
        check_cancelled();
        bool same = true;
        for (auto &t : tokens) {
          check_cancelled();
          if (t[prefix] != tokens[0][prefix])
            same = false;
        }
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
    check_cancelled();
    json logits = json::object(), sizes = json::array();
    for (size_t cursor = 0; cursor < order.size();) {
      check_cancelled();
      size_t end = cursor;
      while (end < order.size() &&
             end - cursor < size_t(full ? 1 : max_batch) &&
             (end - cursor + 1) * (tokens[order[end]].size() - prefix) <=
                 size_t(max_tokens)) {
        check_cancelled();
        end++;
      }
      if (end == cursor)
        throw std::invalid_argument("Suffix exceeds batch token budget");
      sizes.push_back(end - cursor);
      NativeBatch owner(max_tokens);
      auto &batch = owner.value;
      std::vector<int> last;
      for (size_t j = cursor; j < end; j++) {
        check_cancelled();
        int seq = j - cursor + 1;
        auto i = order[j];
        if (prefix)
          llama_memory_seq_cp(llama_get_memory(ctx), 0, seq, 0, prefix);
        for (size_t k = prefix; k < tokens[i].size(); k++) {
          check_cancelled();
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
        check_cancelled();
        int n = std::min(4096, batch.n_tokens - start);
        llama_batch part = batch;
        part.n_tokens = n;
        part.token += start;
        part.pos += start;
        part.n_seq_id += start;
        part.seq_id += start;
        part.logits += start;
        int code = llama_decode(ctx, part);
        check_cancelled();
        if (code) {
          throw std::runtime_error("Native suffix forward failed: " +
                                   std::to_string(code));
        }
        forwards++;
        computed += n;
        for (size_t j = 0; j < last.size(); j++) {
          check_cancelled();
          if (last[j] >= start && last[j] < start + n) {
            auto i = order[cursor + j];
            auto row = llama_get_logits_ith(ctx, last[j] - start);
            if (!row) {
              throw std::runtime_error("Missing scoring logits");
            }
            json selected = json::object();
            for (auto it = branches[i].at("token_ids").begin();
                 it != branches[i].at("token_ids").end(); it++) {
              check_cancelled();
              float v = row[it.value().get<int>()];
              if (!std::isfinite(v)) {
                throw std::runtime_error("Non-finite selected logit");
              }
              selected[it.key()] = v;
            }
            logits[branches[i].at("branch_id").get<std::string>()] = selected;
          }
        }
      }
      for (size_t j = cursor; j < end; j++) {
        check_cancelled();
        llama_memory_seq_rm(llama_get_memory(ctx), j - cursor + 1, -1, -1);
      }
      cursor = end;
    }
    // Logical unique-prefix accounting is independent of executed batches.
    std::map<std::pair<int, llama_token>, int> trie;
    int lengths = 0;
    for (auto &t : tokens) {
      check_cancelled();
      lengths += t.size();
      int node = 0;
      for (auto token : t) {
        check_cancelled();
        auto key = std::make_pair(node, token);
        auto found = trie.find(key);
        if (found == trie.end())
          found = trie.emplace(key, trie.size() + 1).first;
        node = found->second;
      }
    }
    check_cancelled();
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
  bool protocol_failed = false;
  std::string active;
  std::set<std::string> cancelled_requests;
  std::string pending_cancel;
  std::thread reader([&] {
    try {
      while (true) {
        std::string line;
        auto *input = std::cin.rdbuf();
        bool reached_eof = false;
        while (true) {
          const auto next = input->sbumpc();
          if (next == std::char_traits<char>::eof()) {
            reached_eof = true;
            break;
          }
          if (next == '\n')
            break;
          if (line.size() == max_protocol_line)
            throw std::invalid_argument("Native protocol line exceeds 64 MiB");
          line.push_back(char(next));
        }
        if (line.empty() && reached_eof)
          break;
        auto r = json::parse(
            line, [](int depth, json::parse_event_t, json &) {
              if (depth > 32)
                throw std::invalid_argument("Native protocol nesting exceeds 32");
              return true;
            });
        if (!r.is_object() || !r.contains("op") ||
            !r.at("op").is_string())
          throw std::invalid_argument("Invalid native protocol envelope");
        std::lock_guard<std::mutex> lock(mutex);
        if (r.at("op") == "cancel") {
          if (!r.contains("v") ||
              integer(r.at("v"), 1, 1, "Unsupported protocol") != 1 ||
              !r.contains("target") || !r.at("target").is_string())
            throw std::invalid_argument("Invalid native cancellation envelope");
          const auto target = r.at("target").get<std::string>();
          if (target.empty() || target.size() > 128)
            throw std::invalid_argument("Invalid native cancellation ID");
          if (target == active)
            cancelled = true;
          else if (!requests.empty() && requests.front().at("id") == target)
            cancelled_requests.insert(target);
          else
            // One RPC is submitted at a time. Keep at most one cancellation
            // that arrived before its request; late replies cannot accumulate
            // completed IDs or displace cancellation of a queued request.
            pending_cancel = target;
        } else {
          if (!r.contains("id") || !r.at("id").is_string() ||
              r.at("id").get_ref<const std::string &>().empty() ||
              r.at("id").get_ref<const std::string &>().size() > 128)
            throw std::invalid_argument("Invalid native request ID");
          if (!requests.empty())
            throw std::invalid_argument("Native protocol request queue is full");
          requests.push(std::move(r));
        }
        cv.notify_one();
      }
    } catch (const json::exception &) {
      std::cerr << "Native protocol rejected malformed JSON\n";
      std::lock_guard<std::mutex> lock(mutex);
      protocol_failed = true;
      cancelled = true;
    } catch (const std::exception &e) {
      std::cerr << "Native protocol rejected input: " << e.what() << '\n';
      std::lock_guard<std::mutex> lock(mutex);
      protocol_failed = true;
      cancelled = true;
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
      if (protocol_failed || requests.empty())
        break;
      r = requests.front();
      requests.pop();
      active = r.value("id", "");
      cancelled = cancelled_requests.erase(active) > 0 || active == pending_cancel;
      if (active == pending_cancel)
        pending_cancel.clear();
    }
    json response = {{"v", 1}, {"id", r.value("id", "")}};
    try {
      if (!r.contains("v") ||
          integer(r.at("v"), 1, 1, "Unsupported protocol") != 1)
        throw std::invalid_argument("Unsupported protocol");
      check_cancelled();
      const auto op = r.value("op", "");
      if (op == "init") {
        engine.init(r);
        response["result"] = engine.status();
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
    } catch (const json::exception &) {
      if (engine.ctx)
        llama_memory_clear(llama_get_memory(engine.ctx), true);
      response["error"] = {{"message", "Malformed native request fields"},
                           {"kind", "invalid_request"}};
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
  return protocol_failed ? 2 : 0;
}
