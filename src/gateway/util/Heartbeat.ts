/*
  Fosscord: A FOSS re-implementation and extension of the Discord.com backend.
  Copyright (C) 2023 Fosscord and Fosscord Contributors

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as published
  by the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/* eslint-disable no-param-reassign */
import { GatewayCloseCodes } from "discord.js";
import { WebSocket } from "../Socket";

export function setHeartbeat(socket: WebSocket) {
  if (socket.heartbeatTimeout) clearTimeout(socket.heartbeatTimeout);

  socket.heartbeatTimeout = setTimeout(
    () => socket.close(GatewayCloseCodes.SessionTimedOut),
    1000 * 45,
  );
}
