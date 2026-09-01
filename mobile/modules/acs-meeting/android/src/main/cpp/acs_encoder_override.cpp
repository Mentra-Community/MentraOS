#include <android/log.h>
#include <jni.h>
#include <link.h>
#include <sys/mman.h>
#include <unistd.h>

#include <cstdint>
#include <cstring>
#include <string>

namespace {

constexpr char kLogTag[] = "ACS-HW-OVERRIDE";

// ACS Calling 2.16.0, arm64-v8a. The offset is deliberately part of the
// signature check so an updated ACS media engine is never patched merely
// because it happens to contain a similar instruction sequence elsewhere.
constexpr uintptr_t kExpectedFactoryBranchOffset = 0xDFE070;
constexpr uint32_t kMovX20X0 = 0xaa0003f4;
constexpr uint32_t kBranchToSoftware = 0x36000143;
constexpr uint32_t kHardwareAllocTag = 0x528e6ec1;
constexpr uint32_t kHardwareObjectSize = 0x52806100;
constexpr uint32_t kNop = 0xd503201f;

struct FactoryPatchContext {
  bool libraryFound = false;
  bool signatureMatched = false;
  bool patched = false;
  std::string error;
};

int patchHardwareFactoryBranch(dl_phdr_info* info, size_t /* size */, void* data) {
  if (info->dlpi_name == nullptr ||
      std::strstr(info->dlpi_name, "libRtmMediaManagerDyn.so") == nullptr) {
    return 0;
  }

  auto* context = static_cast<FactoryPatchContext*>(data);
  context->libraryFound = true;

#if !defined(__aarch64__)
  context->error = "unsupported ABI; ACS encoder patch is arm64-only";
  return 1;
#else
  for (ElfW(Half) index = 0; index < info->dlpi_phnum; ++index) {
    const ElfW(Phdr)& segment = info->dlpi_phdr[index];
    if (segment.p_type != PT_LOAD || (segment.p_flags & PF_X) == 0) continue;

    const uintptr_t segmentStart = segment.p_vaddr;
    const uintptr_t segmentEnd = segmentStart + segment.p_memsz;
    if (kExpectedFactoryBranchOffset < segmentStart + sizeof(uint32_t) ||
        kExpectedFactoryBranchOffset + (2 * sizeof(uint32_t)) >= segmentEnd) {
      continue;
    }

    auto* branch = reinterpret_cast<uint32_t*>(
      info->dlpi_addr + kExpectedFactoryBranchOffset
    );
    if (branch[-1] != kMovX20X0 ||
        branch[0] != kBranchToSoftware ||
        branch[1] != kHardwareAllocTag ||
        branch[2] != kHardwareObjectSize) {
      context->error = "ACS encoder factory signature mismatch; library left untouched";
      return 1;
    }
    context->signatureMatched = true;

    const long pageSize = sysconf(_SC_PAGESIZE);
    if (pageSize <= 0) {
      context->error = "could not determine system page size";
      return 1;
    }
    const uintptr_t address = reinterpret_cast<uintptr_t>(branch);
    const uintptr_t page = address & ~(static_cast<uintptr_t>(pageSize) - 1);
    if (mprotect(
          reinterpret_cast<void*>(page),
          static_cast<size_t>(pageSize),
          PROT_READ | PROT_WRITE | PROT_EXEC
        ) != 0) {
      context->error = "could not make ACS encoder factory writable";
      return 1;
    }

    branch[0] = kNop;
    __builtin___clear_cache(
      reinterpret_cast<char*>(branch),
      reinterpret_cast<char*>(branch + 1)
    );
    if (mprotect(
          reinterpret_cast<void*>(page),
          static_cast<size_t>(pageSize),
          PROT_READ | PROT_EXEC
        ) != 0) {
      context->error = "patched ACS encoder factory but could not restore RX protection";
      return 1;
    }

    context->patched = true;
    __android_log_print(
      ANDROID_LOG_WARN,
      kLogTag,
      "selected ACS H264 hardware factory at relative offset=0x%zx",
      static_cast<size_t>(kExpectedFactoryBranchOffset)
    );
    return 1;
  }

  context->error = "expected ACS encoder factory address is not executable";
  return 1;
#endif
}

std::string applyOverride() {
  FactoryPatchContext context;
  dl_iterate_phdr(patchHardwareFactoryBranch, &context);

  if (context.patched) return "ACS hardware H264 encoder selected";
  if (!context.libraryFound) return "ACS media engine is not loaded; library left untouched";
  if (!context.error.empty()) return context.error;
  return "ACS hardware encoder patch was not applied";
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_mentra_acsmeeting_AcsEncoderOverride_nativeApply(
  JNIEnv* env,
  jobject /* receiver */
) {
  const std::string result = applyOverride();
  return env->NewStringUTF(result.c_str());
}
