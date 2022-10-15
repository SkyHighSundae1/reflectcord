/* eslint-disable camelcase */
import { Application } from "express";
import { Resource } from "express-automatic-routes";
import { API } from "revolt.js";
import { Guild } from "../../../../common/models";

export default (express: Application) => <Resource> {
  get: async (req, res) => {
    const { guild_id } = req.params;

    if (!guild_id) return res.sendStatus(504);

    const api = res.rvAPI;

    const server = await api.get(`/servers/${guild_id}`).catch(() => {
      res.sendStatus(500);
    }) as API.Server;
    if (!server) return;

    return res.json(await Guild.from_quark(server));
  },
  delete: (req, res) => {
    // Don't implement. This is VERY dangerous ATM.
    res.sendStatus(500);
  },
};
