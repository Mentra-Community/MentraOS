# Production mobile promotion blocked

Beta Mentra App binaries built from a source commit containing this marker
embed the staging Cloud V2 Core and Runtime endpoints. The coordinated
production workflow must not promote those signed bytes to production stores.

Remove this marker only together with a production-promotion design that
produces or selects production-backed signed mobile binaries.
