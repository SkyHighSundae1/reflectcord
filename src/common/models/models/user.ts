import { AccountInfo, User as RevoltUser, UserProfile as RevoltUserProfile } from "revolt-api";
import { ActivityType, APIUser, PresenceData } from "discord.js";
import { QuarkConversion } from "../QuarkConversion";

export type APIUserProfile = {
  bio: string | null,
  accent_color: any | null,
  banner: string | null,
}

export type revoltUserInfo = {
  user: RevoltUser,
  authInfo: AccountInfo;
}

export const User: QuarkConversion<RevoltUser, APIUser> = {
  async to_quark(user) {
    const { bot, id, username } = user;

    return {
      _id: id,
      username,
      relations: null,
      badges: null,
      status: null,
      profile: null, // FIXME
      flags: null,
      privileged: false,
      bot: bot ? {
        owner: "0",
      } : null,
      relationship: null,
      online: null,
    };
  },

  async from_quark(user) {
    return {
      accent_color: null,
      avatar: user.avatar?._id ?? null,
      bot: !!user.bot,
      banner: user.profile?.background?._id ?? null,
      discriminator: "1",
      flags: 0,
      id: user._id,
      locale: "en-US",
      mfa_enabled: false,
      username: user.username,
      public_flags: 0,
      system: false,
      verified: true, // all accounts on revolt are implicitly verified
    };
  },
};

export const UserProfile: QuarkConversion<RevoltUserProfile, APIUserProfile> = {
  async to_quark(profile) {
    const { bio, banner } = profile;

    return {
      content: bio,
      background: banner ? {
        _id: banner,
        tag: "avatars",
        filename: "banner.jpg",
        metadata: {
          type: "Image",
          width: 0,
          height: 0,
        },
        content_type: "attachment",
        size: 0,
      } : null,
    };
  },

  async from_quark(profile) {
    return {
      bio: profile.content ?? null,
      accent_color: null,
      banner: profile.background?._id ?? null,
    };
  },
};

/**
 * Same as normal user, but includes additional info such as email.
 */
export const selfUser: QuarkConversion<revoltUserInfo, APIUser> = {
  async to_quark(user) {
    return {
      user: await User.to_quark(user),
      authInfo: {
        email: user.email ?? "fixme",
        _id: user.id,
      },
    };
  },

  async from_quark(user) {
    return {
      ...await User.from_quark(user.user),
      email: user.authInfo.email,
    };
  },
};

export const Status: QuarkConversion<RevoltUser["status"], PresenceData> = {
  async to_quark(status) {
    return {
      presence: (() => {
        switch (status.status) {
          case "online": {
            return "Online";
          }
          case "idle": {
            return "Idle";
          }
          case "dnd": {
            return "Busy";
          }
          case "invisible": {
            return "Invisible";
          }
          default: {
            return null;
          }
        }
      })(),
    };
  },

  async from_quark(status) {
    const discordStatus: PresenceData = {
      status: (() => {
        switch (status?.presence) {
          case "Online": {
            return "online";
          }
          case "Idle": {
            return "idle";
          }
          case "Busy": {
            return "dnd";
          }
          case "Invisible": {
            return "invisible";
          }
          case "Focus": {
            return "dnd";
          }
          default: {
            throw new Error(`Unhandled status ${status?.presence}`);
          }
        }
      })(),
      activities: [{
        name: status.text ?? "fixme", // @ts-ignore
        type: ActivityType.Custom,
      }],
    };

    return discordStatus;
  },
};
