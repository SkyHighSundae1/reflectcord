/* eslint-disable camelcase */
import { Response } from "express";
import { Resource } from "express-automatic-routes";
import { fromSnowflake, toSnowflake } from "@reflectcord/common/models";
import { HTTPError } from "@reflectcord/common/utils";

export default () => <Resource> {
  get: async (req, res: Response) => {
    const { guild_id } = req.params;

    if (!guild_id) throw new HTTPError("Invalid params");

    const serverId = await fromSnowflake(guild_id);

    const server = await res.rvAPIWrapper.servers.fetch(serverId);

    res.json(await Promise.all(server.revolt.channels.map((x) => toSnowflake(x))));
  },
};
