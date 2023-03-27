import { API } from "revolt.js";

export type DiscoveryUsage = "high" | "medium" | "low"

export type DiscoveryMedia = API.File;

export type DiscoveryServer = {
  _id: string,
  name: string,
  icon?: DiscoveryMedia,
  banner?: DiscoveryMedia,
  description: string,
  flags: number,
  tags: string[],
  members: number,
  /**
   * High: Usually 2000 or more messages in the past 12 hours
   * Medium: Around 800 messages in the past 12 hours
   * Low: Little to no messages in the past 12 hours
   */
  activity: DiscoveryUsage,
}

export interface ImageMetadata {
  type: string;
  width: number;
  height: number;
}

export type Avatar = API.File;

export interface Profile {
  content?: string | null;
  background?: Avatar | null;
}

export interface DiscoveryBot {
  _id: string;
  username: string;
  avatar: Avatar | null;
  profile?: Profile | null;
  tags: string[];
  servers: number;
  usage: DiscoveryUsage;
  install_params?: {
    scopes: string[],
    permissions: string,
  };
}

export type pageProps = {
  popularTags?: string[],
  relatedTags?: string[],
}

/**
 * Properties that all data responses have in common
 */
type GenericDiscoveryResponse = {
  __N_SSG: boolean,
  pageProps: pageProps,
}

export type ServerDiscoveryResponse = GenericDiscoveryResponse & {
  pageProps: pageProps & {
    servers: DiscoveryServer[],
  }
}

export type BotDiscoveryResponse = GenericDiscoveryResponse & {
  pageProps: pageProps & {
    bots: DiscoveryBot[],
  }
}
