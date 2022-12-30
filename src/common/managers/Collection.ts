import { API } from "revolt.js";
import { APIWrapper } from "../rvapi";

export default class Collection<K, V> extends Map<K, V> {
  rvAPI: API.API;

  apiWrapper: APIWrapper;

  constructor(apiWrapper: APIWrapper) {
    super();

    this.rvAPI = apiWrapper.rvAPI;
    this.apiWrapper = apiWrapper;
  }
}
