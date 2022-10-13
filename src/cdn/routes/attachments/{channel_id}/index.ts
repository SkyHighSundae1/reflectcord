import { Application } from "express";
import { Resource } from "express-automatic-routes";

export default (express: Application) => <Resource> {
  post: (req, res) => {
    res.sendStatus(500);
  },
};