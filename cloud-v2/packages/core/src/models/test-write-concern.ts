/** Acknowledgements mean Mongo has durably replicated the accepted state. */
export const testWriteConcern = {w: "majority" as const, j: true, wtimeout: 10_000};
