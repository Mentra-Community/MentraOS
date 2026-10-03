import {RoutineDefinitionModel} from "../models/routine-definition.model";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {expect, spyOn, test} from "bun:test";
import {RoutineDefinitionService, type RoutineDefinitionRepository} from "./routine-definition.service";
import {requestInputDigest} from "./test-request.service";

const revision = "a".repeat(40);
function enrollment(): RoutineEnrollment {
  const definition: RoutineEnrollment["definition"] = {id: "no-glasses", title: "App navigation", purpose: "Check app navigation",
    platforms: ["ios-on-mac"], entry: "home", account: "lane", requires: [], requirements: ["Dedicated test account"],
    fixtures: [], steps: [{id: "settings", instruction: "Open Settings", expected: "Settings is visible"}],
    source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision, path: "routines/no-glasses/routine.ts"}};
  return {routineId: definition.id, platform: "ios-on-mac", definitionRevision: revision,
    definitionSha256: requestInputDigest(definition), definition};
}

test("definition enrollment refuses changed identity or digest before storage", async () => {
  let writes = 0;
  const repository: RoutineDefinitionRepository = {async enroll() {writes++;}, async current() {return [];}, async getCurrent() {return null;}};
  const service = new RoutineDefinitionService(repository);
  const row = enrollment();
  await expect(service.enroll({...row, routineId: "notes"})).rejects.toThrow("Invalid");
  await expect(service.enroll({...row, definitionSha256: "b".repeat(64)})).rejects.toThrow("digest");
  await expect(service.enroll({...row, definition: {...row.definition, steps: [...row.definition.steps, ...row.definition.steps]}}))
    .rejects.toThrow("Invalid");
  expect(writes).toBe(0);
  expect(await service.enroll(row)).toEqual(row);
  expect(writes).toBe(1);
});


test("standalone Mongo enrollment uses one immutable insert and reconciles duplicate revisions", async () => {
  const row = enrollment();
  const insert = spyOn(RoutineDefinitionModel, "create").mockRejectedValue(Object.assign(new Error("duplicate"), {code: 11000}));
  const find = spyOn(RoutineDefinitionModel, "findOne").mockReturnValue({lean: async () => row} as unknown as ReturnType<typeof RoutineDefinitionModel.findOne>);
  const transaction = spyOn(RoutineDefinitionModel.db, "transaction");
  try {
    expect(await new RoutineDefinitionService().enroll(row)).toEqual(row);
    expect(transaction).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith([row], {writeConcern: {w: "majority", j: true, wtimeout: 10000}});
    find.mockReturnValue({lean: async () => ({...row, definitionSha256: "b".repeat(64)})} as unknown as ReturnType<typeof RoutineDefinitionModel.findOne>);
    await expect(new RoutineDefinitionService().enroll(row)).rejects.toThrow("different contents");
  } finally {insert.mockRestore(); find.mockRestore(); transaction.mockRestore();}
});
