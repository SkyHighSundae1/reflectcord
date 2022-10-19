/* eslint-disable camelcase */
import { Application } from "express";
import { Resource } from "express-automatic-routes";

export default (express: Application) => <Resource> {
  patch: (req, res) => {
    res.sendStatus(204);
  },
};