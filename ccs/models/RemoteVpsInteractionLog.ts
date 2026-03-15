import { InferSchemaType, Model, Schema, model, models } from "mongoose";

import {
  initiatedByOptions,
  logDirectionOptions,
  logInteractionTypeOptions,
  logResultOptions,
} from "@/lib/remote-vps-shared";

const remoteVpsInteractionLogSchema = new Schema(
  {
    vpsId: {
      type: Schema.Types.ObjectId,
      ref: "RemoteVps",
      required: true,
      index: true,
    },
    correlationId: {
      type: String,
      required: true,
      trim: true,
    },
    direction: {
      type: String,
      enum: logDirectionOptions,
      required: true,
    },
    interactionType: {
      type: String,
      enum: logInteractionTypeOptions,
      required: true,
    },
    requestMethod: {
      type: String,
      default: "GET",
      trim: true,
    },
    requestPath: {
      type: String,
      default: "/",
      trim: true,
    },
    requestPayload: {
      type: Schema.Types.Mixed,
      default: null,
    },
    responseStatusCode: {
      type: Number,
      default: null,
    },
    responsePayload: {
      type: Schema.Types.Mixed,
      default: null,
    },
    result: {
      type: String,
      enum: logResultOptions,
      required: true,
    },
    errorCode: {
      type: String,
      default: "",
      trim: true,
    },
    errorMessage: {
      type: String,
      default: "",
      trim: true,
    },
    durationMs: {
      type: Number,
      default: null,
    },
    attempt: {
      type: Number,
      default: 1,
      required: true,
      min: 1,
    },
    initiatedBy: {
      type: String,
      enum: initiatedByOptions,
      required: true,
    },
    initiatedByUserId: {
      type: String,
      default: "",
      trim: true,
    },
    createdAt: {
      type: Date,
      default: () => new Date(),
      required: true,
    },
  },
  {
    collection: "remote_vps_interaction_logs",
    versionKey: false,
  }
);

remoteVpsInteractionLogSchema.index({ vpsId: 1, createdAt: -1 });
remoteVpsInteractionLogSchema.index({ correlationId: 1 });
remoteVpsInteractionLogSchema.index({ vpsId: 1, result: 1, interactionType: 1, createdAt: -1 });
remoteVpsInteractionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export type RemoteVpsInteractionLogDocument = InferSchemaType<
  typeof remoteVpsInteractionLogSchema
> & {
  _id: { toString(): string };
};

const RemoteVpsInteractionLogModel =
  (models.RemoteVpsInteractionLog as
    | Model<RemoteVpsInteractionLogDocument>
    | undefined) ??
  model<RemoteVpsInteractionLogDocument>(
    "RemoteVpsInteractionLog",
    remoteVpsInteractionLogSchema
  );

export default RemoteVpsInteractionLogModel;
