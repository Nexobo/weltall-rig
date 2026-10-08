# Weltall control map

The generated rig has **67 visible controls**, 51 native joints, 91 unique reference actions representing 120 source clips, five partial neutral pose assets, and seven demonstration actions. Native joint hierarchy, pivots, mesh parts, UVs, materials, pixel textures, and source motion are preserved.

Blue controls are left, red are right, and gold are central. Bone collections group Body, FK arms, FK legs, IK, Contacts, Armor, and Wings. Widget offsets help visibility without moving the bone's pivot. Mechanisms are unselectable; the armature object's transforms and animator scale channels are locked. Place the character with `CTRL-root`.

## Channels and defaults

- **T** means editable translation; **R** means editable rotation. Locked channels still evaluate original animation curves.
- The original 53 controls retain quaternion rotation. The 14 added controls use XYZ Euler rotation. Do not change rotation modes on source controls.
- Neutral translation/rotation offsets are zero; scale is one. Contact and added body controls start unkeyed.
- Each wrist and foot owns `ik_blend`: **0 FK**, **1 IK**, with smooth intermediate blending. Reference actions keep blends at zero and IK/pole transforms unanimated. Set the IK pose before blending; there is no automatic FK/IK matching.
- Wrist `hand`: **0 open**, **1 closed**, **2 both**, **3 hidden**. The original rest and reset default are **2**. Source visibility keys are preserved.
- The model is made of rigid pieces with fixed limb lengths. An IK chain clamps at full reach; it does not stretch.

## Original controls (53)

Paired rows include both `.L` and `.R`. Native joint numbers are left/right in that order.

| Control | Native joint(s) | Editable channels and purpose |
|---|---|---|
| `CTRL-root` | Ground origin | T/R. Entire character placement; carries root-relative targets. |
| `CTRL-body` | 0 | T/R. Body weight/COG; moves all native joints. |
| `CTRL-hips` | 15 | T/R. Legacy **torso base**, including skirt; does not move leg sockets. |
| `CTRL-spine` | 16 | R. Upper torso, including shoulder and torso-shell branches. |
| `CTRL-chest` | 17 | R. Legacy **shoulder girdle**; carries arms, not head or torso shell. |
| `CTRL-torso_armor` | 30 | R. Torso shell, head, and wing pieces. |
| `CTRL-head` | 31 | T/R. Head articulation and native sliding; follow changes orientation only. |
| `CTRL-clavicle.L`, `.R` | 18 / 24 | R. Shoulder sockets. |
| `CTRL-upper_arm.L`, `.R` | 19 / 25 | R. Upper-arm FK. |
| `CTRL-forearm.L`, `.R` | 20 / 26 | R. Forearm FK. |
| `CTRL-hand_fk.L`, `.R` | 21 / 27 | R. FK wrist. |
| `CTRL-hand_ik.L`, `.R` | Wrist 21 / 27 | T/R. Wrist IK goal; owns arm blend, hand state, and following. |
| `CTRL-elbow.L`, `.R` | Pole | T. Arm bend direction; rotation locked, including quaternion W. |
| `CTRL-thigh.L`, `.R` | 2 / 9 | R. Thigh FK. |
| `CTRL-shin.L`, `.R` | 4 / 11 | R. Shin FK. |
| `CTRL-ankle_fk.L`, `.R` | 5 / 12 | R. FK ankle. |
| `CTRL-foot_ik.L`, `.R` | Ankle 5 / 12 | T/R. Ankle IK goal; owns leg blend and following. |
| `CTRL-knee.L`, `.R` | Pole | T. Leg bend direction; rotation locked, including quaternion W. |
| `CTRL-foot.L`, `.R` | 6 / 13 | R. Foot detail; follows the evaluated ankle through FK/IK blending. |
| `CTRL-toe.L`, `.R` | 7 / 14 | R. Rigid toe detail; follows the foot. |
| `CTRL-foot_inner.L`, `.R` | 38 / 43 | R. Original rear foot piece farther from center; legacy name retained. |
| `CTRL-foot_outer.L`, `.R` | 39 / 44 | R. Original rear foot piece nearer center; legacy name retained. |
| `CTRL-knee_armor.L`, `.R` | 3 / 10 | T/R. Knee shell clearance. |
| `CTRL-thigh_armor.L`, `.R` | 37 / 41 | T/R. Thigh shell clearance. |
| `CTRL-shin_armor.L`, `.R` | 40 / 42 | R. Shin shell. |
| `CTRL-upper_arm_armor.L`, `.R` | 45 / 48 | R. Upper-arm shell. |
| `CTRL-forearm_armor.L`, `.R` | 46 / 47 | R. Forearm shell. |
| `CTRL-skirt.L`, `.R` | 36 / 35 | T/R. Independent skirt clearance. |
| `CTRL-wing_root.L`, `.R` | 33 / 32 | R. Main wings. |
| `CTRL-wing_panel.L`, `.R` | 50 / 49 | R. Wing panels; independent native branches, not wing-root children. |

## Added body controls (2)

| Control | Channels | Purpose |
|---|---|---|
| `CTRL-pelvis` | T/R | Offsets both leg sockets and skirt together, independently of the upper torso. |
| `CTRL-chest_pose` | R | Unified chest offset for shoulders, torso shell, arms, head, and wings. |

Original `CTRL-hips` and `CTRL-chest` names remain because their source animation curves must retain their meaning. The sidebar labels them **Torso base (legacy hips)** and **Shoulder girdle (legacy chest)**.

## Added contact controls (12)

Paired rows include `.L` and `.R`. Contacts operate through the limb's IK blend; they are zero and unkeyed in reference actions.

| Control | Editable channels | Purpose |
|---|---|---|
| `CTRL-heel_contact.L`, `.R` | Euler X pitch, Z swivel | Rotate around heel sole; lift forefoot or swivel toe. |
| `CTRL-ball_contact.L`, `.R` | Euler X | Lift heel while keeping toe planted. |
| `CTRL-toe_contact.L`, `.R` | Euler X pitch, Z swivel | Roll over toe tip or swivel heel around toe. |
| `CTRL-bank_contact.L`, `.R` | Euler Y | Rock on either actual sole edge. |
| `CTRL-wrist_pivot.L`, `.R` | T | Place an adjustable hand-contact pivot; moving it alone leaves the hand still. |
| `CTRL-hand_contact.L`, `.R` | Euler XYZ | Rotate the hand around its adjustable pivot for bracing or striking. |

Forward is negative Y. Foot contact pivots come from the extracted sole geometry. Foot/toe FK controls remain available for individual pieces.

## Follow spaces

| Control | Modes | Default |
|---|---|---|
| Wrist/foot IK goals | Root / Body / World | Root |
| Elbow/knee poles | Root / Body / Goal | Root |
| Head orientation | Torso / Root / World | Torso |

Head position follows the torso in every mode. Use **Change Follow (Keep Pose)** in the sidebar to change space without moving the evaluated control pose. The button keys the previous pose/space one frame earlier and the compensated pose/new space now, with stepped space keys. It works in NLA Tweak Mode and **writes keys even with Auto Key off**. Use it on a working action. Editing raw `follow` does not compensate the pose. Follow changes do not match or switch FK/IK.

## Pose and keying tools

Run **RIG CONTROLS - Run Script** in the Text Editor with **Alt+P** to register the **Weltall Rig** sidebar. Six saved selection sets cover Whole Body, Body, and each arm/leg. Seven dynamic keying sets add Selected; they key active FK channels at blend 0, active IK at blend 1, both between them, and relevant hand/blend/follow properties.

Blender's pose copy/paste, flipped paste, X-axis mirroring, reset, and pose sliding work with the controls. Pose sliding needs surrounding keys on the working action. Source quaternion rotations are retained; added manual rotation controls use Euler.

Five **Current File** pose assets reset Body, Arm L/R, and Leg L/R independently. Body Neutral preserves root placement. **Alt+G/Alt+R** reset editable transforms; **Backspace** over a custom property restores its default. Clear Transforms alone does not reset blend, hand, or follow values.

Before changing demos or returning to references: leave Tweak Mode, turn Auto Key off, mute Reference animations, clear the active Action with X, fully apply all five neutral assets, then reset `CTRL-root` with Alt+G and Alt+R. Choose the next action, or leave the Action empty and unmute Reference animations.

Import bakes evaluated motion onto the native hierarchy and omits controls/pose assets. Animated channels reset to recorded neutral values between independent actions. Unkeyed manual offsets remain shared; key offsets that should belong only to one action. See [the guide](guide.html) for the complete workflow.
