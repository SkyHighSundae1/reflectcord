/* eslint-disable camelcase */
import { Application } from "express";
import { Resource } from "express-automatic-routes";

export default (express: Application) => <Resource> {
  delete: (req, res) => {
    res.sendStatus(200);
  },
};
