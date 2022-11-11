import {
  ResponseLogin as RevoltLoginResponse,
  DataLogin as RevoltDataLogin,
} from "revolt-api";
import { QuarkConversion } from "../../QuarkConversion";
import { LoginSchema } from "../../../sparkle";

export type APILoginResponse = {
  token: string | null,
  settings: any,
  ticket?: string | undefined, // MFA ticket
  sms?: boolean | undefined,
  mfa?: boolean | undefined,
}

export const ResponseLogin: QuarkConversion<RevoltLoginResponse, APILoginResponse> = {
  async to_quark(login) {
    const { token } = login;

    return {
      token: token ?? "",
      result: "Success",
      user_id: "", // FIXME,
      name: "",
      _id: "",
    };
  },

  async from_quark(login) {
    const isMFA = login.result === "MFA";

    if (isMFA) {
      return {
        token: null,
        settings: undefined,
        ticket: login.ticket,
        sms: false,
        mfa: true,
      };
    }

    return {
      token: login.token,
      settings: undefined,
    };
  },
};

export const DataLogin: QuarkConversion<RevoltDataLogin, LoginSchema> = {
  async to_quark(data) {
    return {
      email: data.login,
      password: data.password,
      captcha: data.captcha_key ?? null,
    };
  },

  async from_quark(data) {
    const isMFA = ("mfa_ticket" in data);

    return {
      login: isMFA ? "fixme" : data.email,
      password: isMFA ? "fixme" : data.password,
      captcha_key: isMFA ? "fixme" : data.captcha ?? "fixme",
    };
  },
};
