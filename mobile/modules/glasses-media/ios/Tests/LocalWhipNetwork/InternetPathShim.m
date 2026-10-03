#import <Network/Network.h>
#include <string.h>
#include <stdlib.h>
#include <stdatomic.h>
static atomic_bool enabled = false;
void enableMissingWifiPath(void) { atomic_store(&enabled, true); }
// Test process only: model an internet NWPath that lists cellular but omits en0.
static const char *internet_interface_name(nw_interface_t interface) {
  const char *name = nw_interface_get_name(interface);
  return atomic_load(&enabled) && name && getenv("WHIP_TEST_INTERFACE") && strcmp(name, getenv("WHIP_TEST_INTERFACE")) == 0 ? "pdp_ip0" : name;
}
static nw_interface_type_t internet_interface_type(nw_interface_t interface) {
  const char *name = nw_interface_get_name(interface);
  return atomic_load(&enabled) && name && getenv("WHIP_TEST_INTERFACE") && strcmp(name, getenv("WHIP_TEST_INTERFACE")) == 0 ? nw_interface_type_cellular : nw_interface_get_type(interface);
}
#define INTERPOSE(replacement, original) \
__attribute__((used)) static struct { const void *replacement; const void *original; } \
interpose_##original __attribute__((section("__DATA,__interpose"))) = { (const void *)&replacement, (const void *)&original };
INTERPOSE(internet_interface_name, nw_interface_get_name)
INTERPOSE(internet_interface_type, nw_interface_get_type)
