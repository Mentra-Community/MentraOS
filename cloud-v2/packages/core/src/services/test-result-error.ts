export class TestRunError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 416 | 422 | 503, message: string) {super(message);}
}
