# manager/

Per-user manager classes. Each manager handles one responsibility and is instantiated inside the `User` class (`session/User.ts`).

| Class                    | Responsibility                                      |
| ------------------------ | --------------------------------------------------- |
| `SessionManager`         | Thin lookup — `Map<userId, User>` with get/create/remove |
| `PhotoManager`           | Photo capture, in-memory storage, SSE broadcasting  |
| `TranscriptionManager`   | Speech-to-text listener, SSE broadcasting           |
| `AudioManager`           | Text-to-speech and audio stop                       |
| `StorageManager`         | Theme preferences via MentraOS Simple Storage       |
| `InputManager`           | Button presses and touchpad gestures                |

Every manager (except `SessionManager`) receives a back-reference to its `User` so it can access `this.user.appSession` and `this.user.userId`.
