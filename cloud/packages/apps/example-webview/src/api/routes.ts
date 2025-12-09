/**
 * API Routes for Captions App
 */

export const routes = {
  "/api/hello": {
    async GET(req: Request) {
      return Response.json({
        message: "Hello from Captions API!",
        method: "GET",
      });
    },
    async PUT(req: Request) {
      return Response.json({
        message: "Hello from Captions API!",
        method: "PUT",
      });
    },
  },

  "/api/hello/:name": async (req: Request) => {
    const name = req.params.name;
    return Response.json({
      message: `Hello, ${name}!`,
    });
  },

  "/api/captions/status": {
    async GET(req: Request) {
      return Response.json({
        active: true,
        captionsEnabled: true,
      });
    },
  },
};
