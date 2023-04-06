/* eslint-disable camelcase */
/* eslint-disable no-param-reassign */
/* eslint-disable no-plusplus */
import {
  APIChannel,
  APIUser,
  ApplicationFlagsBitField,
  GatewayCloseCodes,
  GatewayDispatchEvents,
  GatewayGuildCreateDispatchData,
  GatewayGuildDeleteDispatchData,
  GatewayGuildMemberAddDispatchData,
  GatewayGuildMemberRemoveDispatchData,
  GatewayGuildMemberUpdateDispatchData,
  GatewayGuildRoleDeleteDispatchData,
  GatewayGuildRoleUpdateDispatchData,
  GatewayInteractionCreateDispatchData,
  GatewayMessageCreateDispatchData,
  GatewayMessageDeleteBulkDispatchData,
  GatewayMessageDeleteDispatchData,
  GatewayMessageReactionAddDispatchData,
  GatewayMessageReactionRemoveDispatchData,
  GatewayMessageReactionRemoveEmojiDispatchData,
  GatewayTypingStartDispatchData,
  InteractionType,
} from "discord.js";
import { API } from "revolt.js";
import { APIWrapper, createAPI, systemUserID } from "@reflectcord/common/rvapi";
import {
  Channel,
  Emoji,
  Guild,
  HandleChannelsAndCategories,
  Member,
  PartialEmoji,
  Relationship,
  selfUser,
  Status,
  User,
  toSnowflake,
  GuildCategory,
  SettingsKeys,
  RevoltSettings,
  UserSettings,
  settingsToProtoBuf,
  ReadState,
  Role,
  createCommonGatewayGuild,
  createUserPresence,
  interactionTitle,
  findComponentByIndex,
  convertDescriptorToComponent,
  multipleToSnowflake,
  GatewaySessionDTO,
  identifyClient,
  createUserGatewayGuild,
} from "@reflectcord/common/models";
import { Logger, RabbitMQ } from "@reflectcord/common/utils";
import { userStartTyping } from "@reflectcord/common/events";
import {
  GatewayUserChannelUpdateOptional,
  IdentifySchema,
  GatewayUserSettingsProtoUpdateDispatchData,
  GatewayDispatchCodes,
  MergedMember,
  ReadyData,
  DefaultUserSettings,
  Session,
  IdentifyCapabilities,
  DefaultCapabilities,
} from "@reflectcord/common/sparkle";
import { reflectcordWsURL } from "@reflectcord/common/constants";
import { VoiceState } from "@reflectcord/common/mongoose";
import { emojiMap as reactionMap } from "@reflectcord/common/managers/";
import { emojis as emojiMap } from "@reflectcord/common/emojilib";
import { Tracer } from "@reflectcord/common/debug";
import { WebSocket } from "../Socket";
import { Dispatch } from "./send";
import experiments from "./experiments.json";
import { isDeprecatedClient } from "../versioning";
import { updateMessage } from "./messages";
import { createInternalListener } from "./InternalListener";

// TODO: rework lol
function cacheServerCreateChannels(
  this: WebSocket,
  rvChannels: API.Channel[],
  discordChannels: APIChannel[],
) {
  rvChannels.forEach((x) => {
    const channelHandler = this.rvAPIWrapper.channels.get(x._id);
    if (!channelHandler
      || !(
        "guild_id" in channelHandler.discord
        && channelHandler.discord.guild_id
      )) return;

    const discordChannel = discordChannels
      .find((ch) => ch.id === channelHandler?.discord.id);

    if (!discordChannel || !("parent_id" in discordChannel && discordChannel.parent_id)) return;
    channelHandler.discord.parent_id = discordChannel.parent_id;
  });
}

export async function startListener(
  this: WebSocket,
  token: string,
  identifyPayload: IdentifySchema,
) {
  this.rvClient.on("packet", async (data) => {
    try {
      switch (data.type) {
        case "Error": {
          if (["InvalidSession", "AlreadyAuthenticated", "InvalidSession"].includes(data.error)) {
            this.close(GatewayCloseCodes.AuthenticationFailed);
          }
          this.close(GatewayCloseCodes.UnknownError);
          break;
        }
        // @ts-ignore
        case "NotFound": {
          this.close(GatewayCloseCodes.AuthenticationFailed);
          break;
        }
        case "Auth": {
          switch (data.event_type) {
            case "DeleteAllSessions": {
              this.close(GatewayCloseCodes.SessionTimedOut);
              break;
            }
            default:
          }
          break;
        }
        case "Ready": {
          const { trace } = this;

          if (identifyPayload.capabilities) {
            const capabilitiesObject = IdentifyCapabilities(identifyPayload.capabilities);
            this.capabilities = capabilitiesObject;
          } else {
            this.capabilities = DefaultCapabilities;
            Logger.warn("Client has no capabilities??");
          }

          trace.startTrace("get_user");

          const currentUser = data.users.find((x) => x.relationship === "User");
          if (!currentUser) return this.close(GatewayCloseCodes.AuthenticationFailed);

          trace.stopTrace("get_user");

          trace.startTrace("reflectcord_init");
          this.bot = !!currentUser.bot;

          if (currentUser.bot) {
            this.rvAPI = createAPI(token);
          } else {
            this.rvAPI = createAPI({
              token,
            });
            this.enable_lazy_channels = process.env["LAZY_MESSAGES"] as unknown as boolean ?? false;
          }
          // HACK! Fixes #10
          // @ts-ignore
          this.rvClient.api = this.rvAPI;
          // @ts-ignore
          this.rvAPIWrapper = new APIWrapper(this.rvAPI);

          this.user_id = await toSnowflake(currentUser._id);
          this.rv_user_id = currentUser._id;

          this.is_deprecated = isDeprecatedClient.call(this);

          this.typingConsumer = await RabbitMQ.channel?.consume(userStartTyping, (msg) => {
            if (!msg) return;

            const { channel, token: userToken } = JSON.parse(msg.content.toString());

            if (userToken === token) {
              this.rvClient.websocket.send({
                type: "BeginTyping",
                channel,
              });

              Logger.log(`started typing in ${channel}`);
            }
          }, { noAck: true });

          trace.stopTrace("reflectcord_init");

          trace.startTrace("fetch_users");
          const users = await Promise.all(data.users
            .map(async (user) => this.rvAPIWrapper.users.createObj({
              revolt: user,
              discord: await User.from_quark(user),
            })));

          const discordUsers = users.map((user) => user.discord);

          const channels = await Promise.all(data.channels
            .map(async (channel) => {
              const recipients: APIUser[] = [];
              if (channel.channel_type === "Group" || channel.channel_type === "DirectMessage") {
                channel.recipients.forEach((x) => {
                  if (x === this.rv_user_id) return;

                  const user = this.rvAPIWrapper.users.get(x);
                  if (user) recipients.push(user.discord);
                });
              }
              const params: any = { excludedUser: currentUser._id };
              if (recipients.length > 0) params.discordRecipients = recipients;

              const discordChannel = await Channel.from_quark(
                channel,
                params,
              );
              const channelObj = this.rvAPIWrapper.channels.createObj({
                revolt: channel,
                discord: discordChannel,
              });

              return channelObj;
            }));
          trace.stopTrace("fetch_users");

          trace.startTrace("fetch_private_channels");
          const private_channels = channels
            .filter((x) => x.revolt.channel_type === "DirectMessage" || x.revolt.channel_type === "Group" || x.revolt.channel_type === "SavedMessages")
            .map((x) => x.discord);

          trace.stopTrace("fetch_private_channels");

          trace.startTrace("fetch_emojis");
          if (data.emojis) {
            await Promise.all(data.emojis
              .filter((x) => x.parent.type === "Server")
              .map(async (x) => this.rvAPIWrapper.emojis.createObj({
                revolt: x,
                discord: await Emoji.from_quark(x, {
                  discordUser: this.rvAPIWrapper.users.get(x.creator_id)?.discord,
                }),
              })));
          }

          trace.stopTrace("fetch_emojis");

          trace.startTrace("fetch_guilds");

          const lazyGuilds: GatewayGuildCreateDispatchData[] = [];

          const guilds = await Promise.all(data.servers
            .map(async (server) => {
              const rvChannels: API.Channel[] = server.channels
                .map((x) => this.rvAPIWrapper.channels.$get(x)?.revolt).filter((x) => x);

              const emojis = data.emojis
                ?.filter((emoji) => emoji.parent.type === "Server" && emoji.parent.id === server._id)
                .map((emoji) => this.rvAPIWrapper.emojis.get(emoji._id)!);

              const rvServer = this.rvAPIWrapper.servers.createObj({
                revolt: server,
                discord: await Guild.from_quark(server, {
                  discordEmojis: emojis?.map((emoji) => emoji.discord),
                }),
              });

              const discordGuild = rvServer.discord;

              const member = await rvServer.extra?.members
                .fetch(rvServer.revolt._id, this.rv_user_id);

              const serverChannels = await HandleChannelsAndCategories(
                rvChannels,
                server.categories,
                server._id,
              );

              cacheServerCreateChannels.call(this, rvChannels, serverChannels);

              if (currentUser.bot || !this.capabilities.ClientStateV2) {
                const commonGuild = createCommonGatewayGuild(discordGuild, {
                  channels: serverChannels,
                  members: member ? [member.discord] : [],
                  member: member ? member.discord : null,
                });

                const legacyGuild = {
                  ...discordGuild,
                  ...commonGuild,
                };

                if (!currentUser.bot) return legacyGuild;

                const botGuild = {
                  ...legacyGuild,
                  unavailable: false,
                };

                lazyGuilds.push(botGuild);
                return { id: discordGuild.id, unavailable: true };
              }

              const guild = await createUserGatewayGuild(discordGuild, {
                channels: serverChannels,
                members: member ? [member.discord] : [],
                member: member ? member.discord : null,
              });

              return guild;
            }));

          trace.stopTrace("fetch_guilds");

          trace.startTrace("fetch_user_stage2");
          const mfaInfo = !currentUser.bot ? await this.rvAPI.get("/auth/mfa/") : null;
          const authInfo = !currentUser.bot ? await this.rvAPI.get("/auth/account/") : null;
          const currentUserDiscord = await selfUser.from_quark({
            user: currentUser,
            authInfo: authInfo ?? {
              _id: currentUser._id,
              email: "fixme@gmail.com",
            },
            mfaInfo,
          });
          this.rvAPIWrapper.users.createObj({
            revolt: currentUser,
            discord: currentUserDiscord,
          });

          trace.stopTrace("fetch_user_stage2");

          trace.startTrace("fetch_sessions");
          const sessionStatus = await Status.from_quark(currentUser.status);
          const currentSession: Session = {
            activities: sessionStatus.activities ?? [],
            client_info: {
              version: 0,
              client: identifyClient(identifyPayload.properties?.browser ?? "Discord Client"),
            },
            status: identifyPayload?.presence?.status.toString() ?? "offline",
            session_id: this.session_id,
          };
          if (identifyPayload.properties?.os) {
            currentSession.client_info.os = identifyPayload.properties?.os;
          }

          const sessions = [new GatewaySessionDTO(currentSession)];
          trace.stopTrace("fetch_sessions");

          trace.startTrace("fetch_members");
          const memberData = (await Promise.all(data.members.map(async (x) => {
            const server = this.rvAPIWrapper.servers.$get(x._id.server);
            const member = {
              revolt: x,
              discord: await Member.from_quark(x, {
                discordUser: this.rvAPIWrapper.users.get(x._id.user)?.discord,
              }),
            };

            server.extra?.members.createObj(member);

            return { member, guild: server.discord };
          })));
          trace.stopTrace("fetch_members");

          trace.startTrace("relationships");
          const relationships = await Promise.all(users
            .filter((u) => u.revolt.relationship !== "None" && u.revolt.relationship !== "User")
            .map(async (u) => ({
              discord: {
                type: await Relationship.from_quark(u.revolt.relationship ?? "Friend"),
                user: u.discord,
              },
              revolt: u.revolt,
            })));
          trace.stopTrace("relationships");

          trace.startTrace("fetch_presences");

          const friendPresences = await Promise.all(relationships
            .map((relationship) => createUserPresence({
              user: relationship.revolt,
              discordUser: relationship.discord.user,
            })));

          trace.stopTrace("fetch_presences");

          trace.startTrace("fetch_settings");
          const rvSettings = !currentUser.bot ? await this.rvAPI.post("/sync/settings/fetch", {
            keys: SettingsKeys,
          }).catch(() => null) as unknown as RevoltSettings : null;

          const user_settings = rvSettings ? await UserSettings.from_quark(rvSettings, {
            status: sessionStatus.status?.toString() || null,
          }) : null;

          trace.stopAndStart("fetch_settings", "fetch_settings_proto");
          const user_settings_proto = rvSettings
            ? await settingsToProtoBuf(user_settings as any, {
              customStatusText: currentUser.status?.text,
            })
            : null;
          trace.stopTrace("fetch_settings_proto");

          trace.startTrace("fetch_read_state");

          const unreads = await this.rvAPIWrapper.messages.fetchUnreads();
          const readStateEntries = await Promise.all(unreads.map((x) => ReadState.from_quark(x)));

          trace.stopTrace("fetch_read_state");

          const readyData: ReadyData = {
            v: this.version,
            users: discordUsers,
            user_settings_proto: user_settings_proto ? Buffer.from(user_settings_proto).toString("base64") : null,
            user_settings: user_settings ?? DefaultUserSettings,
            user: currentUserDiscord,
            guilds,
            guild_experiments: [],
            geo_ordered_rtc_regions: ["newark", "us-east"],
            relationships: relationships.map((x) => ({
              id: x.discord.user.id,
              type: x.discord.type,
              nickname: x.discord.user.username,
              user: x.discord.user,
            })),
            read_state: this.capabilities.VersionedReadStates ? {
              entries: readStateEntries,
              partial: false,
              version: 304128,
            } : readStateEntries,
            user_guild_settings: this.capabilities.VersionedUserGuildSettings ? {
              entries: user_settings?.user_guild_settings ?? [],
              partial: false,
              version: 642,
            } : user_settings?.user_guild_settings ?? [],
            experiments, // ily fosscord
            private_channels,
            resume_gateway_url: reflectcordWsURL,
            session_id: this.session_id,
            sessions,
            friend_suggestion_count: 0,
            guild_join_requests: [],
            connected_accounts: [],
            analytics_token: "",
            tutorial: null,
            session_type: "normal",
            api_code_version: 1,
            consents: {
              personalization: {
                consented: false, // never gonna fix this lol
              },
            },
            country_code: "US",
            // V6 & V7 garbo
            indicators_confirmed: [],
            _trace: [],
            shard: [0, 1],
            auth_session_id_hash: "",
          };

          trace.startTrace("clean_ready");

          if (this.capabilities.UserSettingsProto) {
            // We opt to delete it here to avoid a race condition with Discord Mobile
            delete readyData.user_settings;
          }
          if (!this.capabilities.LazyUserNotes) {
            readyData.notes = {};
          }
          if (this.capabilities.DeduplicateUserObjects) {
            trace.startTrace("create_merged_member_dtos");
            const mergedMembers: MergedMember[][] = [];

            // TODO: Abstract into DTO
            memberData.forEach((member_data) => {
              const { guild, member } = member_data;

              const guildIndex = guilds.findIndex((x) => x.id === guild.id);

              mergedMembers[guildIndex] ??= [];

              const hoistedRoles = guild.roles
                .filter((role) => role.hoist && member.discord.roles
                  .find((member_role) => member_role === role.id));

              /**
             * FIXME: When we eventually sort role positions correctly,
             * this code will need to be adjusted
            */
              const hoisted_role = hoistedRoles
                .sort((r1, r2) => r1.position - r2.position)[0];

              const mergedMember: MergedMember = {
                ...member.discord,
                user_id: member.discord.user!.id, // FIXME: This might break
              };

              delete mergedMember.user;

              if (hoisted_role) mergedMember.hoisted_role = hoisted_role;

            mergedMembers[guildIndex]!.push(mergedMember);
            });
            trace.stopTrace("create_merged_member_dtos");

            readyData.merged_members = mergedMembers;
            readyData.merged_presences = {
              guilds: [
                [],
                [],
              ],
              friends: [],
            };
          } else {
            readyData.presences = friendPresences;
            // WORKAROUND: race condition on mobile
            delete readyData.users;
          }

          if (currentUserDiscord.bot) {
            readyData.application = {
              id: currentUserDiscord.id,
              flags: new ApplicationFlagsBitField().toJSON(),
            };
          }

          trace.stopTrace("clean_ready");

          readyData._trace.push(JSON.stringify(trace.toGatewayObject()));
          await Dispatch(this, GatewayDispatchEvents.Ready, readyData);

          trace.startTrace("start_internal_listener");
          await createInternalListener.call(this);
          trace.stopTrace("start_internal_listener");

          await Promise.all(lazyGuilds
            .map((x) => Dispatch(this, GatewayDispatchEvents.GuildCreate, x).catch(Logger.error)));

          if (!currentUserDiscord.bot) {
            const supplementalData = {
              disclose: [],
              guilds: await Promise.all(guilds.map(async (x) => ({
                id: x.id,
                embedded_activities: [],
                voice_states: (await VoiceState.find({ guild_id: x.id })),
              }))),
              lazy_private_channels: [],
              merged_members: [],
              merged_presences: {
                friends: friendPresences,
                guilds: [],
              },
            };

            await Dispatch(this, GatewayDispatchCodes.ReadySupplemental, supplementalData);
          }

          setImmediate(async () => {
            if (this.bot) return;

            Dispatch(this, GatewayDispatchCodes.SessionsReplace, sessions)
              .catch(Logger.error);
            Dispatch(this, GatewayDispatchEvents.PresenceUpdate, {
              user: currentUserDiscord,
              ...currentSession,
              client_status: {
                desktop: currentSession.status,
              },
            }).catch(Logger.error);
          });

          break;
        }
        case "Message": {
          if (this.enable_lazy_channels && !this.lazy_channels[data.channel]) {
            return;
          }

          const msgObj = await this.rvAPIWrapper.messages.convertMessageObj(
            data,
            { mentions: true },
            { api_version: this.version },
          );
          this.rvAPIWrapper.messages.createObj({
            revolt: msgObj.revolt.message,
            discord: msgObj.discord,
          });
          const channel = await this.rvAPIWrapper.channels.fetch(data.channel);

          this.rvAPIWrapper.channels.update(data.channel, {
            revolt: {
              last_message_id: data._id,
            },
            discord: {
              last_message_id: await toSnowflake(data._id),
            },
          });

          const body: GatewayMessageCreateDispatchData = msgObj.discord;

          if ("guild_id" in channel.discord && channel.discord.guild_id && "server" in channel.revolt) {
            const server = await this.rvAPIWrapper.servers.fetch(channel.revolt.server);

            body.guild_id = channel.discord.guild_id;

            if (data.author !== systemUserID) {
              const member = await server.extra?.members
                .fetch(channel.revolt.server, data.author);

              if (member) body.member = member.discord;
            }
          }

          await Dispatch(this, GatewayDispatchEvents.MessageCreate, body);

          break;
        }
        case "MessageUpdate": {
          if (this.enable_lazy_channels && !this.lazy_channels[data.channel]) {
            return;
          }

          await updateMessage.call(this, data);
          break;
        }
        case "MessageDelete": {
          if (this.enable_lazy_channels && !this.lazy_channels[data.channel]) {
            return;
          }

          const channel = await this.rvAPIWrapper.channels.fetch(data.channel);

          const body: GatewayMessageDeleteDispatchData = {
            id: await toSnowflake(data.id),
            channel_id: channel.discord.id,
          };

          if ("guild_id" in channel.discord && channel.discord.guild_id) body.guild_id = channel.discord.guild_id;

          await Dispatch(this, GatewayDispatchEvents.MessageDelete, body);

          this.rvAPIWrapper.messages.delete(data.id);

          break;
        }
        case "MessageReact": {
          if (this.enable_lazy_channels && !this.lazy_channels[data.channel_id]) {
            return;
          }

          const isInEmojiMap = !!emojiMap[data.emoji_id];
          const emoji = !isInEmojiMap ? await this.rvAPIWrapper.emojis.fetch(data.emoji_id) : null;
          const channel = await this.rvAPIWrapper.channels.fetch(data.channel_id);
          const message = await this.rvAPIWrapper.messages.fetch(data.channel_id, data.id);
          const interactionEmbed = message.revolt.embeds?.last();

          if (interactionEmbed?.type === "Text" && interactionEmbed.title === interactionTitle && interactionEmbed.description) {
            const revoltReactionNumber = reactionMap[data.emoji_id];

            if (revoltReactionNumber !== undefined) {
              const revoltComponent = findComponentByIndex(
                interactionEmbed.description,
                revoltReactionNumber,
              );
              if (revoltComponent) {
                const component = convertDescriptorToComponent(revoltComponent);

                const user = await this.rvAPIWrapper.users.fetch(data.user_id);
                const server = "server" in channel.revolt ? await this.rvAPIWrapper.servers.fetch(channel.revolt.server) : null;
                const interactionData: GatewayInteractionCreateDispatchData = {
                  id: message.discord.id,
                  application_id: this.user_id,
                  data: {
                    custom_id: component.custom_id,
                    component_type: component.type,
                  },
                  type: InteractionType.MessageComponent,
                  channel_id: channel.discord.id,
                  token: message.discord.id,
                  version: 1,
                  message: message.discord,
                  locale: "en-US",
                  app_permissions: "0", // TODO (interactions): App permissions
                };

                if (server) {
                  interactionData.member = {
                    ...(await server.extra!.members
                      .fetch(server.revolt._id, user.revolt._id)).discord,
                    permissions: "0", // TODO (interactions) Member permissions
                    user: user.discord,
                  };
                  interactionData.guild_id = server.discord.id;
                } else interactionData.user = user.discord;

                await Dispatch(this, GatewayDispatchCodes.InteractionCreate, interactionData);
              }
            }
          }

          if (!emoji) return;

          const body: GatewayMessageReactionAddDispatchData = {
            user_id: await toSnowflake(data.user_id),
            channel_id: message.discord.channel_id,
            message_id: message.discord.id,
            emoji: await PartialEmoji.from_quark(emoji.revolt),
          };

          if (emoji.revolt.parent.type === "Server") {
            body.guild_id = await toSnowflake(emoji.revolt.parent.id);
          }

          await Dispatch(this, GatewayDispatchEvents.MessageReactionAdd, body);

          break;
        }
        case "MessageUnreact": {
          if (this.enable_lazy_channels && !this.lazy_channels[data.channel_id]) {
            return;
          }

          const emoji = await this.rvAPIWrapper.emojis.fetch(data.emoji_id);

          const body: GatewayMessageReactionRemoveDispatchData = {
            user_id: await toSnowflake(data.user_id),
            channel_id: await toSnowflake(data.channel_id),
            message_id: await toSnowflake(data.id),
            emoji: await PartialEmoji.from_quark(emoji.revolt),
          };

          if (emoji.revolt.parent.type === "Server") {
            body.guild_id = await toSnowflake(emoji.revolt.parent.id);
          }

          await Dispatch(this, GatewayDispatchEvents.MessageReactionRemove, body);

          break;
        }
        case "MessageRemoveReaction": {
          if (this.enable_lazy_channels && !this.lazy_channels[data.channel_id]) {
            return;
          }
          const emoji = await this.rvAPIWrapper.emojis.fetch(data.emoji_id);

          const body: GatewayMessageReactionRemoveEmojiDispatchData = {
            channel_id: await toSnowflake(data.channel_id),
            message_id: await toSnowflake(data.id),
            emoji: await PartialEmoji.from_quark(emoji.revolt),
          };

          if (emoji.revolt.parent.type === "Server") {
            body.guild_id = await toSnowflake(emoji.revolt.parent.id);
          }

          await Dispatch(this, GatewayDispatchEvents.MessageReactionRemoveEmoji, body);

          break;
        }
        case "MessageAppend": {
          if (this.enable_lazy_channels && !this.lazy_channels[data.channel]) {
            return;
          }

          await updateMessage.call(this, data);
          break;
        }
        case "BulkMessageDelete": {
          if (this.enable_lazy_channels && !this.lazy_channels[data.channel]) {
            return;
          }

          const channel = await this.rvAPIWrapper.channels.fetch(data.channel);

          const body: GatewayMessageDeleteBulkDispatchData = {
            ids: await multipleToSnowflake(data.ids),
            channel_id: channel.discord.id,
          };

          if ("guild_id" in channel.discord && channel.discord.guild_id) {
            body.guild_id = channel.discord.guild_id;
          }

          await Dispatch(this, GatewayDispatchEvents.MessageDeleteBulk, body);

          data.ids.forEach((msg) => this.rvAPIWrapper.messages.delete(msg));

          break;
        }
        case "ChannelStartTyping": {
          const channel = await this.rvAPIWrapper.channels.fetch(data.id);

          const body: GatewayTypingStartDispatchData = {
            channel_id: channel.discord.id,
            user_id: await toSnowflake(data.user),
            timestamp: Date.nowSeconds(),
          };

          if ("guild_id" in channel.discord && channel.discord.guild_id && "server" in channel.revolt) {
            if (!this.bot
              && this.capabilities.ClientStateV2
              && !this.subscribed_servers[channel.revolt.server]?.typing) {
              return;
            }
            body.guild_id = channel.discord.guild_id;
            body.member = (await this.rvAPIWrapper.members
              .fetch(channel.revolt.server, data.user)).discord;
          }

          await Dispatch(this, GatewayDispatchEvents.TypingStart, body);

          break;
        }
        case "ChannelCreate": {
          const channel = this.rvAPIWrapper.channels.createObj({
            revolt: data,
            discord: await Channel.from_quark(data),
          });

          if (channel.revolt.channel_type === "TextChannel" || channel.revolt.channel_type === "VoiceChannel") {
            const server = await this.rvAPIWrapper.servers.fetch(channel.revolt.server);
            if (!server.revolt.channels.includes(channel.revolt._id)) {
              server.revolt.channels.push(channel.revolt._id);
            }
          }

          await Dispatch(this, GatewayDispatchEvents.ChannelCreate, channel.discord);

          break;
        }
        case "ChannelUpdate": {
          const channelHandle = this.rvAPIWrapper.channels.get(data.id);
          if (channelHandle) {
            // TODO: Better clear functions
            this.rvAPIWrapper.channels.update(data.id, {
              revolt: data.data,
              discord: {},
            }, data.clear);

            this.rvAPIWrapper.channels.update(data.id, {
              revolt: data.data,
              discord: await Channel.from_quark({
                ...channelHandle.revolt,
                ...data.data,
              } as API.Channel),
            }, data.clear);

            const body: GatewayUserChannelUpdateOptional = {
              ...channelHandle.discord,
            };

            if (!this.bot) {
              const stubGatewayHash = {
                omitted: false,
                hash: "NpY9iQ",
              };
              const stubHash = {
                channels: stubGatewayHash,
                metadata: stubGatewayHash,
                roles: stubGatewayHash,
                version: 1,
              };
              body.guild_hashes = stubHash;
              body.version = 1671679879788;
            }

            await Dispatch(this, GatewayDispatchEvents.ChannelUpdate, body);
          }

          break;
        }
        case "ChannelDelete": {
          const channel = this.rvAPIWrapper.channels.get(data.id);

          await Dispatch(this, GatewayDispatchEvents.ChannelDelete, channel?.discord);

          if (channel) {
            await this.rvAPIWrapper.channels.deleteChannel(channel.revolt._id, false, true);
          }

          break;
        }
        case "ServerCreate": {
          await Promise.all(data.channels
            .map(async (x) => this.rvAPIWrapper.channels.createObj({
              revolt: x,
              discord: await Channel.from_quark(x),
            })));

          const channels = await HandleChannelsAndCategories(
            data.channels,
            data.server.categories,
            data.server._id,
          );

          cacheServerCreateChannels.call(this, data.channels, channels);

          const guild = this.rvAPIWrapper.servers.createObj({
            revolt: data.server,
            discord: await Guild.from_quark(data.server),
          });

          const member = await this.rvAPIWrapper.members.fetch(data.server._id, this.rv_user_id);

          const commonGuild = createCommonGatewayGuild(guild.discord, {
            channels,
            members: member ? [member.discord] : [],
            member: member ? member.discord : null,
          });

          const userGuild = await createUserGatewayGuild(guild.discord, {
            channels,
            members: member ? [member.discord] : [],
            member: member ? member.discord : null,
          });

          const botGuild = {
            ...commonGuild,
            ...guild.discord,
            unavailable: false,
          };

          await Dispatch(
            this,
            GatewayDispatchEvents.GuildCreate,
            this.capabilities.ClientStateV2 ? userGuild : botGuild,
          );

          break;
        }
        case "ServerDelete": {
          const server = this.rvAPIWrapper.servers.get(data.id);

          await Dispatch(this, GatewayDispatchEvents.GuildDelete, {
            id: server?.discord.id ?? await toSnowflake(data.id),
          });

          if (server) {
            await this.rvAPIWrapper.servers.removeServer(server.revolt._id, false, true);
          }

          break;
        }
        case "ServerUpdate": {
          const server = this.rvAPIWrapper.servers.get(data.id);
          if (server) {
            const deletedCategories = server.revolt.categories
              ?.filter((category) => data.data.categories
                ?.find((x) => x.id === category.id) === undefined);

            const rvEmojis = Array.from(this.rvAPIWrapper.emojis.values())
              .filter((x) => x.revolt.parent.type === "Server" && x.revolt.parent.id === server.revolt._id);

            this.rvAPIWrapper.servers.update(server.revolt._id, {
              revolt: data.data,
              discord: await Guild.from_quark({
                ...server.revolt,
                ...data.data,
              }, {
                emojis: rvEmojis.map((x) => x.revolt),
              }),
            });

            if (data.data.categories) {
              await Promise.all(data.data.categories.map(async (x) => {
                // Only emit channelcreate for new categories - the rest get "updated"
                const eventType = server.revolt.categories?.find((c) => x.id === c.id)
                  ? GatewayDispatchEvents.ChannelUpdate
                  : GatewayDispatchEvents.ChannelCreate;

                const discordCategory = await GuildCategory.from_quark(x, {
                  server: data.id,
                });

                await Dispatch(this, eventType, discordCategory);

                await Promise.all(x.channels.map(async (id) => {
                  const channel = this.rvAPIWrapper.channels.get(id);
                  if (!channel || !("parent_id" in channel.discord)) return;

                  if (discordCategory.id === channel.discord.parent_id) return;

                  channel.discord.parent_id = discordCategory.id;
                  await Dispatch(this, GatewayDispatchEvents.ChannelUpdate, channel.discord);
                }));
              }));
            }

            if (deletedCategories) {
              await Promise.all(deletedCategories
                .map(async (category) => Dispatch(
                  this,
                  GatewayDispatchEvents.ChannelDelete,
                  await GuildCategory.from_quark(category),
                )));
            }

            await Dispatch(this, GatewayDispatchEvents.GuildUpdate, server.discord);
          }

          break;
        }
        case "ServerMemberJoin": {
          const server = this.rvAPIWrapper.servers.get(data.id);
          if (!server?.extra?.members) return;

          const member = await server.extra.members.fetch(data.id, data.user);

          const body: GatewayGuildMemberAddDispatchData = {
            ...member.discord,
            guild_id: await toSnowflake(data.id),
          };

          await Dispatch(this, GatewayDispatchEvents.GuildMemberAdd, body);

          break;
        }
        case "ServerMemberUpdate": {
          const server = this.rvAPIWrapper.servers.get(data.id.server);
          if (!server?.extra?.members) return;

          const member = await server.extra.members.fetch(data.id.server, data.id.user);
          server.extra.members.update(data.id.user, {
            revolt: data.data,
            discord: {},
          }, data.clear);

          server.extra.members.update(data.id.user, {
            revolt: data.data,
            discord: await Member.from_quark({
              ...member.revolt,
              ...data.data,
            }, {
              discordUser: member.discord.user,
            }),
          }, data.clear);

          const body: GatewayGuildMemberUpdateDispatchData = {
            ...member.discord,
            user: member.discord.user ?? (await this.rvAPIWrapper.users
              .fetch(data.id.user)).discord,
            guild_id: await toSnowflake(data.id.server),
          };

          // TODO: Update the member list if subscribed
          await Dispatch(
            this,
            GatewayDispatchEvents.GuildMemberUpdate,
            body,
          );

          break;
        }
        case "ServerMemberLeave": {
          const server = this.rvAPIWrapper.servers.get(data.id);

          const guildId = server?.discord.id ?? await toSnowflake(data.id);

          // TODO: Validate if this is correct
          if (data.user === this.rv_user_id) {
            const body: GatewayGuildDeleteDispatchData = {
              id: guildId,
              unavailable: false,
            };

            await this.rvAPIWrapper.servers.removeServer(data.id, false, true);

            await Dispatch(this, GatewayDispatchEvents.GuildDelete, body);

            return;
          }

          const user = await this.rvAPIWrapper.users.fetch(data.user);

          const body: GatewayGuildMemberRemoveDispatchData = {
            guild_id: guildId,
            user: user.discord,
          };

          await Dispatch(this, GatewayDispatchEvents.GuildMemberRemove, body);

          server?.extra?.members.delete(data.user);

          break;
        }
        case "ChannelStopTyping": {
          // Discord wont handle this no matter what
          break;
        }
        case "UserUpdate": {
          const user = await this.rvAPIWrapper.users.fetch(data.id);

          // TODO: Make it so we don't have to do this to clear revolt beforehand
          this.rvAPIWrapper.users.update(data.id, {
            revolt: data.data ?? {},
            discord: {},
          }, data.clear);

          this.rvAPIWrapper.users.update(data.id, {
            revolt: data.data ?? {},
            discord: await User.from_quark({
              ...user.revolt,
              ...data.data,
            }),
          }, data.clear);

          if (data.id !== this.rv_user_id) {
            if (data.data.status || data.data.online !== null || data.data.online !== undefined) {
              const updated = await createUserPresence({
                user: user.revolt,
                discordUser: user.discord,
              });

              await Dispatch(this, GatewayDispatchEvents.PresenceUpdate, updated);
            }

            return;
          }

          await Dispatch(this, GatewayDispatchEvents.UserUpdate, user.discord);

          break;
        }
        case "ChannelAck": {
          await Dispatch(this, GatewayDispatchCodes.MessageAck, {
            channel_id: await toSnowflake(data.id),
            message_id: await toSnowflake(data.message_id),
            version: 3763,
          });
          break;
        }
        case "EmojiCreate": {
          if (data.parent.type !== "Server") return;

          const emoji = this.rvAPIWrapper.emojis.createObj({
            revolt: data,
            discord: await Emoji.from_quark(data),
          });

          await Dispatch(this, GatewayDispatchEvents.GuildEmojisUpdate, {
            guild_id: await toSnowflake(data.parent.id),
            emojis: [emoji.discord],
          });

          break;
        }
        case "ServerRoleUpdate": {
          const server = this.rvAPIWrapper.servers.get(data.id);
          if (server) {
            const rvRole = {
              ...server.revolt.roles?.[data.role_id],
              ...data.data,
            } as API.Role;
            const discordRole = await Role.from_quark(rvRole, data.role_id);
            let existingDiscord = server.discord.roles.find((x) => x.id === discordRole.id);
            const isUpdate = !!existingDiscord;

            existingDiscord = {
              ...existingDiscord,
              ...discordRole,
            };
            if (!isUpdate) server.discord.roles.push(existingDiscord);

            server.revolt.roles = {
              ...server.revolt.roles,
              [data.role_id]: rvRole,
            };

            const body: GatewayGuildRoleUpdateDispatchData = {
              guild_id: server.discord.id,
              role: discordRole,
            };

            const dispatchType = isUpdate
              ? GatewayDispatchEvents.GuildRoleUpdate
              : GatewayDispatchEvents.GuildRoleCreate;

            await Dispatch(this, dispatchType, body);
          }

          break;
        }
        case "ServerRoleDelete": {
          const server = this.rvAPIWrapper.servers.get(data.id);
          if (server) {
            const { [data.role_id]: _, ...roles } = server.revolt.roles ?? {};
            const discordRoleId = await toSnowflake(data.role_id);
            server.revolt.roles = roles;
            server.discord.roles = server.discord.roles.filter((x) => x.id !== discordRoleId);

            const body: GatewayGuildRoleDeleteDispatchData = {
              guild_id: server.discord.id,
              role_id: discordRoleId,
            };

            await Dispatch(this, GatewayDispatchEvents.GuildRoleDelete, body);
          }
          break;
        }
        case "UserRelationship": {
          const user = await User.from_quark(data.user);
          const { id } = user;
          const type = await Relationship.from_quark(data.status);
          const nickname = data.user.username;

          const body = {
            id,
            type,
            nickname,
            user,
          };

          if (["Friend", "Outgoing", "Incoming", "Blocked"].includes(data.status)) {
            await Dispatch(this, GatewayDispatchCodes.RelationshipAdd, body);
          } else {
            await Dispatch(this, GatewayDispatchCodes.RelationshipRemove, body);
          }

          break;
        }
        case "UserSettingsUpdate": {
          const user = this.rvAPIWrapper.users.get(this.rv_user_id);
          if (!user) return;

          const currentSettings = await this.rvAPI.post("/sync/settings/fetch", {
            keys: SettingsKeys,
          }) as RevoltSettings;

          const discordSettings = await UserSettings.from_quark(currentSettings, {
            status: user.revolt.status
              ? (await Status.from_quark(user.revolt.status)).status ?? null
              : null,
          });

          const settingsProto = await settingsToProtoBuf(discordSettings, {
            customStatusText: user.revolt.status?.text,
          });

          const body: GatewayUserSettingsProtoUpdateDispatchData = {
            partial: false,
            settings: {
              proto: Buffer.from(settingsProto).toString("base64"),
              type: 1,
            },
          };

          await Dispatch(this, GatewayDispatchCodes.UserSettingsProtoUpdate, body);
          if (!this.capabilities.UserSettingsProto) {
            await Dispatch(this, GatewayDispatchCodes.UserSettingsUpdate, discordSettings);
          }

          break;
        }
        case "Pong": {
          break;
        }
        default: {
          Logger.warn(`Unknown event type ${data.type}`);
          break;
        }
      }
    } catch (e) {
      console.error("Error during ws handle:", e);
    }
  });
}
