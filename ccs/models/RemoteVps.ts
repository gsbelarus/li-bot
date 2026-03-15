import { InferSchemaType, Model, Schema, model, models } from "mongoose";

import {
  vpsEnvironmentOptions,
  vpsProtocolOptions,
  vpsStatusOptions,
} from "@/lib/remote-vps-shared";

const remoteVpsSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    host: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    port: {
      type: Number,
      required: true,
      min: 1,
      max: 65535,
    },
    protocol: {
      type: String,
      enum: vpsProtocolOptions,
      required: true,
    },
    environment: {
      type: String,
      enum: vpsEnvironmentOptions,
      required: true,
    },
    region: {
      type: String,
      default: "",
      trim: true,
    },
    provider: {
      type: String,
      required: true,
      trim: true,
    },
    controllerVersion: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: vpsStatusOptions,
      default: "unknown",
      required: true,
    },
    statusReason: {
      type: String,
      default: "Awaiting initial controller communication",
      trim: true,
    },
    lastSeenAt: {
      type: Date,
      default: null,
    },
    lastHealthCheckAt: {
      type: Date,
      default: null,
    },
    lastHealthCheckResult: {
      type: String,
      enum: ["success", "failed", "timeout", "unknown"],
      default: "unknown",
      required: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    notes: {
      type: String,
      default: "",
    },
    isEnabled: {
      type: Boolean,
      default: true,
      required: true,
    },
    createdBy: {
      type: String,
      required: true,
      trim: true,
    },
    updatedBy: {
      type: String,
      required: true,
      trim: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      required: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    collection: "remote_vps",
    timestamps: true,
  }
);

remoteVpsSchema.index({ isDeleted: 1, name: 1 });
remoteVpsSchema.index({ isDeleted: 1, status: 1, environment: 1 });
remoteVpsSchema.index({ protocol: 1, host: 1, port: 1, isDeleted: 1 });

export type RemoteVpsDocument = InferSchemaType<typeof remoteVpsSchema> & {
  _id: { toString(): string };
};

const RemoteVpsModel =
  (models.RemoteVps as Model<RemoteVpsDocument> | undefined) ??
  model<RemoteVpsDocument>("RemoteVps", remoteVpsSchema);

export default RemoteVpsModel;
