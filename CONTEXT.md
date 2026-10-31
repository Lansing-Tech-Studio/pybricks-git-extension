# Pybricks Git

A Chrome extension that gives a robotics team version control over the programs in the code.pybricks.com editor, using the team's GitHub fork as the only source of truth.

## Language

### Repository

**Commit**:
One recorded state of the team's programs on the branch, with a message, an author and a time. The unit a kid sees in History and the unit Commit creates.
_Avoid_: Save point, snapshot, revision

**Branch tip**:
The newest commit on the team's branch on GitHub. Every Pull and Commit starts from it.
_Avoid_: Head, remote head

**History**:
The commits reachable from the branch tip by following first parents, newest first. A merge commit appears once; its changes are everything it brought in.
_Avoid_: Log, timeline

**Protected file**:
A file the fork's manifest reserves for the coach. Commit keeps the repository's copy, and Restore is never offered for it.
_Avoid_: Locked file, read-only file

### Editor

**Now**:
The editor's current contents, including work not yet committed. One side of a "Compared to now" diff.
_Avoid_: Current, working copy, local

**Version**:
One file's contents as of one commit. A diff compares two versions of each file; Restore writes one back.
_Avoid_: Revision, copy

**Restore**:
Writing the selected commit's version of one file into the editor, replacing the current contents or recreating the file. It never deletes a file and never commits.
_Avoid_: Revert, roll back, checkout

**Block program**:
A `.py` file whose first line carries the Blockly workspace as JSON, followed by the Python generated from it. Diffs show the Python body and flag the blocks as changed when the workspace differs.
_Avoid_: Blocks file, block file

**Base**:
The state of each file that the editor and the repository last agreed on, recorded after a Pull or Commit. Tells a locally edited file from one changed upstream.
_Avoid_: Last pull, snapshot
