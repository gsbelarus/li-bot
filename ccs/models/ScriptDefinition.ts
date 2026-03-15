import { InferSchemaType, Model, Schema, model, models } from "mongoose";

import { createEmptyScriptInstructions } from "@/lib/scripts-shared";

const scriptDefinitionSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    plainText: {
      type: String,
      required: true,
    },
    structuredInstructions: {
      type: Schema.Types.Mixed,
      required: true,
      default: () => createEmptyScriptInstructions(),
    },
    isDisabled: {
      type: Boolean,
      default: false,
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
    collection: "scripts",
    timestamps: true,
  }
);

scriptDefinitionSchema.index({ isDeleted: 1, name: 1 });
scriptDefinitionSchema.index({ isDeleted: 1, isDisabled: 1, updatedAt: -1 });

export type ScriptDefinitionDocument = InferSchemaType<typeof scriptDefinitionSchema> & {
  _id: { toString(): string };
};

const ScriptDefinitionModel =
  (models.ScriptDefinition as Model<ScriptDefinitionDocument> | undefined) ??
  model<ScriptDefinitionDocument>("ScriptDefinition", scriptDefinitionSchema);

export default ScriptDefinitionModel;
