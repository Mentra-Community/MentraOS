#include "quickjs_version.h"

const char *quickjs_version() {
#ifdef CONFIG_VERSION
    return CONFIG_VERSION;
#else
    return "not_configured";
#endif
}