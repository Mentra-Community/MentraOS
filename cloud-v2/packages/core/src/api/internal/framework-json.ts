import {bodyLimit} from "hono/body-limit";
import type {Context} from "hono";
import {TestRunError} from "../../services/test-result-error";

export const FRAMEWORK_JSON_BYTES = 1024 * 1024;
export const frameworkBodyLimit = (maxSize = FRAMEWORK_JSON_BYTES) => bodyLimit({maxSize,
  onError: c => c.json({error: "body_too_large"}, 413)});
export async function frameworkJson(c: Context): Promise<unknown> {
  try {return await c.req.json();}
  catch (error) {
    if ((error as {status?: number}).status === 413) throw new TestRunError(413, "Request body exceeds the size limit");
    throw new TestRunError(400, "Invalid JSON");
  }
}
