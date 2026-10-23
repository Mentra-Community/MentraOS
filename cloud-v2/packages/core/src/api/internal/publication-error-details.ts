import {mongo} from 'mongoose';

const errorText = (value: string | undefined) => value?.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[redacted Mongo URI]')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1000);

/** Keep database failure details, never bulk operation bodies or credentials. */
export function publicationErrorDetails(error: Error) {
  const details = {errorName: error.name, errorMessage: errorText(error.message)};
  if (!(error instanceof mongo.MongoServerError)) return details;
  const database = {errorCode: error.code, errorCodeName: error.codeName};
  if (!(error instanceof mongo.MongoBulkWriteError)) return {...details, ...database};
  const concern = error.result.getWriteConcernError();
  const writes = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
  return {...details, ...database, writeErrorCount: writes.length,
    writeErrors: writes.slice(0, 10).map(item => ({index: item.index, code: item.code, message: errorText(item.errmsg)})),
    ...(concern ? {writeConcernError: {code: concern.code, message: errorText(concern.errmsg)}} : {})};
}
