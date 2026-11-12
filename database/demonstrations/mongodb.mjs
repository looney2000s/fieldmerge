// Driver queries reused by the runnable evidence runner. Source evidence is read-only.
export const byRecord = (db, recordId, hint) => {
  let cursor = db
    .collection("submission_documents")
    .find(
      { record_id: recordId },
      { projection: { _id: 1, record_id: 1, form_version: 1, received_at: 1 } },
    )
    .sort({ received_at: 1, _id: 1 });
  return hint ? cursor.hint(hint) : cursor;
};
export const categoryPipeline = [
  { $unwind: "$payload.observations" },
  {
    $group: {
      _id: "$payload.observations.category",
      observations: { $sum: 1 },
    },
  },
  { $sort: { _id: 1 } },
];
export const formPipeline = [
  {
    $group: {
      _id: "$form_version",
      sources: { $sum: 1 },
      observations: {
        $sum: { $size: { $ifNull: ["$payload.observations", []] } },
      },
    },
  },
  { $sort: { _id: 1 } },
];
export const presencePipeline = [
  { $project: { fields: { $objectToArray: "$payload.patch" } } },
  { $unwind: "$fields" },
  {
    $group: {
      _id: "$fields.k",
      proposals: { $sum: 1 },
      explicit_unknowns: {
        $sum: { $cond: [{ $eq: ["$fields.v", null] }, 1, 0] },
      },
    },
  },
  { $sort: { _id: 1 } },
];
