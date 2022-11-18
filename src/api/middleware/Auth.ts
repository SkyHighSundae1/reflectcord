import { NextFunction, Request, Response } from "express";
import { API } from "revolt.js";
import { HTTPError } from "@reflectcord/common/utils";
import { APIWrapper, createAPI } from "@reflectcord/common/rvapi";

export const NoAuthRoutes = [
  "/auth/login",
  "/auth/register",
  "/auth/location-metadata",
  "/auth/mfa/totp",
  // Routes with a seperate auth system
  "/webhooks/",
  // Public information endpoints
  "/ping",
  "/gateway",
  "/experiments",
  "/updates",
  "/downloads/",
  "/scheduled-maintenances/upcoming.json",
  // Client analytics
  // "/science",
  // "/track",
  // Asset delivery
  /\/guilds\/\d+\/widget\.(json|png)/,
];

export const API_PREFIX = /^\/api(\/v\d+)?/;
export const API_PREFIX_TRAILING_SLASH = /^\/api(\/v\d+)?\//;

declare global {
    namespace Express {
        // eslint-disable-next-line no-shadow
        interface Request {
            user_id: string;
            user_bot: boolean;
            token: string;
            // rights: Rights;
        }
        // eslint-disable-next-line no-shadow
        interface Response {
          rvAPI: API.API;
          rvAPIWrapper: APIWrapper,
          fromBot?: boolean;
        }
    }
}

export async function Authentication(req: Request, res: Response, next: NextFunction) {
  if (req.method === "OPTIONS") return res.sendStatus(204);

  res.rvAPI = createAPI();
  res.rvAPIWrapper = new APIWrapper(res.rvAPI);

  const url = req.url.replace(API_PREFIX, "");
  if (url.startsWith("/invites") && req.method === "GET") return next();

  if (
    NoAuthRoutes.some((x) => {
      if (typeof x === "string") return url.startsWith(x);
      return x.test(url);
    })
  ) { return next(); }
  if (!req.headers.authorization) return next(new HTTPError("Missing authorization header!", 401));

  try {
    req.token = req.headers.authorization;
    // Bots emit this at the beginning to signify they're a bot token
    if (req.token.startsWith("Bot ")) {
      req.token = req.token.substring(4);

      res.rvAPI = createAPI(req.token);
      res.fromBot = true;
    } else {
      res.rvAPI = createAPI({
        token: req.token,
      });
    }

    res.rvAPIWrapper = new APIWrapper(res.rvAPI);

    return next();
  } catch (error: any) {
    return next(new HTTPError(error?.toString(), 400));
  }
}
