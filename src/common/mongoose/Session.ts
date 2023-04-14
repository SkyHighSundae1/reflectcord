import mongoose from "mongoose";

/**
 * A Revolt session stored in memory
*/
export const RevoltSessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  token: { type: String, required: true },
  user_id: { type: String, required: false },
  name: { type: String, required: false },
  result: { type: String, required: false },
});

export const RevoltSession = mongoose.model("RevoltSession", RevoltSessionSchema);
