import { Payload } from "../util";
import { WebSocket } from "../Socket";
import { Status } from "../../common/models";

export async function presenceUpdate(this: WebSocket, data: Payload) {
  // FIXME: Make this better/use quarkconversion

  await this.rvAPI.patch("/users/@me", {
    status: await Status.to_quark(data.d) as any,
  });
}
