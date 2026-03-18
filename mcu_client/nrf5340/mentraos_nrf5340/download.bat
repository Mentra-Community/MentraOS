nrfjprog -f NRF53 --coprocessor CP_NETWORK --recover
REM nrfjprog -f NRF53 --coprocessor CP_NETWORK --program build\ipc_radio\zephyr\zephyr.hex --chiperase --verify
nrfjprog -f NRF53 --coprocessor CP_NETWORK --program build\merged_CPUNET.hex --chiperase --verify
REM nrfjprog -f NRF53 --recover
nrfjprog -f NRF53 --program build\merged.hex --chiperase --verify

REM REM nrfjprog --pinreset
pause
