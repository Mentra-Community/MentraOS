#-------------------------------------------------------------------------------
# Copyright (c) 2023, Arm Limited. All rights reserved.
#
# SPDX-License-Identifier: BSD-3-Clause
#
#-------------------------------------------------------------------------------

set(PLATFORM_SLIH_IRQ_TEST_SUPPORT    ON)
set(PLATFORM_FLIH_IRQ_TEST_SUPPORT    ON)

# Make FLIH IRQ test as the default IRQ test on nordic platforms
set(TEST_NS_SLIH_IRQ                  OFF   CACHE BOOL    "Whether to build NS regression Second-Level Interrupt Handling tests")
